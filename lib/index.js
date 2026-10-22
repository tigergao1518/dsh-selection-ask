import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { mountSideSessionFactory } from "./sideSession.js";
import { createRpcHandler, ROUTE_PATH } from "./sideAskRpc.js";
import { registerSessionLogTool } from "./sessionLogTool.js";
import { mountReviewSessionFactory } from "./reviewSession.js";
/**
 * dsh-selection-ask — host 半。
 *
 * 0.1.x 时代这个包是纯 client 插件（所有行为都在浏览器 bundle 里），
 * host 半只是个空壳，好让 composition 有一个可解析的插件体。
 *
 * 现在它提供三样东西：
 *
 *   1. **旁路会话工厂**（sideSession.ts）—— fork 父会话前缀、投递首条提问；
 *   2. **同源 RPC 路由**（sideAskRpc.ts）—— 浏览器半的唯一出入口；
 *   3. **复盘用的日志工具**（sessionLogTool.ts）—— 让复盘会话能按需回查
 *      原始会话事件，而不是把整份日志塞进上下文。
 *
 * 浏览器半仍然负责全部界面：选中捕获、浮动按钮、右侧栏 tab、复盘入口。
 */
export const name = 'dsh-selection-ask';
/**
 * 宿主半需要的官方服务。
 *
 * `subagents` 是必需的：首条提问经 `subagents.queuePrompt` 投递，
 * 它内部「活跃就投 inbox、不活跃就 cold resume」，免去了我们自己
 * 建子 agent（那会与已建会话撞 id）。
 *
 * `tools` 不放进 inject：它在某些组合里可能缺席，缺了只是少一个工具，
 * 不该让整个插件挂掉，所以运行时再取。
 *
 * **不放 `sessionPersistence`**：它被 DSH 的 isolate 隔离，第三方插件
 * 的 fiber 拿不到（不在 Cordis Inspect 服务目录里），属性访问还会抛
 * `cannot get property … without inject`。旁路会话的落盘改由
 * `agents.create` 内部完成（它的 createStoredSession 会调
 * persistence.create），所以根本不需要直接碰这个服务。
 */
export const inject = ['webServer', 'sessions', 'agents', 'subagents'];
/** 解析 DSH 主目录，与 dsh-home-paths 同规则但不必引入它。 */
export function resolveDshHome(configured) {
    if (typeof configured === 'string' && configured.trim() !== '')
        return configured;
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '')
        return fromEnv;
    return join(homedir(), '.dsh');
}
export function apply(ctx) {
    const log = (message) => {
        const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-selection-ask') : undefined;
        if (typeof logger?.warn === 'function')
            logger.warn(message);
        else
            console.warn(message);
    };
    // 工厂与路由都由这个 fiber 持有，插件卸载或热重载时一起消失。
    const createSideSession = mountSideSessionFactory(ctx);
    // 复盘走另一条路：读日志文件 → 新开会话 + 只读预设 + 注入过程数据。
    const sessionsRoot = join(resolveDshHome(), 'sessions');
    const logDeps = {
        sessionsRoot,
        readFile: (path) => readFileSync(path),
        decompress: (frame) => zstdDecompressSync(frame),
        log,
    };
    const createReviewSession = mountReviewSessionFactory(ctx, logDeps);
    const handler = createRpcHandler({ createSideSession, createReviewSession, logger: log });
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }), 'dsh-selection-ask: side-ask rpc route');
    // 复盘工具：让复盘会话能按需回查原始会话事件。
    // zstd 走 Node 内置 zlib，无第三方依赖。
    void registerSessionLogTool(ctx, logDeps)
        .then((disposer) => {
        if (disposer === undefined)
            log('read_session_log 工具未注册（缺 tools 服务）');
    })
        .catch((error) => log(`read_session_log 工具注册失败：${String(error)}`));
}
