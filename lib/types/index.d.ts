import type { Context } from '@deepseek-ai/cordis';
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
export declare const name = "dsh-selection-ask";
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
export declare const inject: string[];
/** 解析 DSH 主目录，与 dsh-home-paths 同规则但不必引入它。 */
export declare function resolveDshHome(configured?: string): string;
export declare function apply(ctx: Context): void;
