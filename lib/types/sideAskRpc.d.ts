import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * 旁路会话的 HTTP 出入口。
 *
 * 静态客户端插件没有 `host.call`（那个符号只属于模型编写的动态包），
 * 所以浏览器半与宿主半之间走所有出厂插件都在用的那条路：
 * 宿主用 `ctx.webServer.register` 挂一个同源 POST 路由，浏览器 fetch 它。
 * 信封统一为 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
 *
 * 这条路由只会创建会话，不写文件、不执行命令，但它能新建 agent 并消耗
 * 模型额度，因此仍然做两道防护：
 *   1. 只接受本机回环请求（插座地址 + Host 头双重判定，绝不看 X-Forwarded-For）；
 *   2. 请求体大小上限，避免被塞爆。
 */
/** 路由路径。 */
export declare const ROUTE_PATH = "/dsh-side-ask/rpc";
/**
 * 回环防护。插座地址才是权威，`X-Forwarded-For` 一律不采信。
 * 这条路由能创建 agent，所以局域网 peer 即使在受信宿主部署下也不该够到它。
 */
export declare function isLoopbackRequest(request: IncomingMessage): boolean;
/** 路由处理函数的依赖。 */
export interface SideAskRpcDeps {
    /** 旁路会话工厂（fork 父会话，用于选中追问）。 */
    readonly createSideSession: (request: {
        parentSessionId: string;
        atSeq?: number;
        agentPreset?: string;
        cwd?: string;
        firstMessage?: string;
    }) => Promise<{
        sessionId: string;
        inheritedEventCount: number;
        agentPreset: string;
    }>;
    /**
     * 复盘会话：新开会话 + 只读预设 + 注入会话过程数据。
     * 与 fork 路分开，因为只有新开会话才能让只读预设真正生效。
     */
    readonly createReviewSession: (request: {
        targetSessionId: string;
        cwd: string;
        agentPreset?: string;
    }) => Promise<{
        sessionId: string;
        agentPreset: string;
        digestTurns: number;
    }>;
    readonly logger?: (message: string) => void;
}
/** 构造路由处理器。 */
export declare function createRpcHandler(deps: SideAskRpcDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 带稳定 code 的 RPC 错误。 */
export declare class SideAskRpcError extends Error {
    readonly code: 'bad-request' | 'not-confirmed' | 'unknown-method' | 'internal';
    constructor(code: 'bad-request' | 'not-confirmed' | 'unknown-method' | 'internal', message: string);
}
