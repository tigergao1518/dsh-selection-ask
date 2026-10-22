/**
 * 浏览器半的旁路会话客户端。
 *
 * 静态客户端插件没有 `host.call`，所以与宿主半通信走所有出厂插件都在用的
 * 那条路：同源 POST 到 host 注册的 `/dsh-side-ask/rpc`。
 * 信封统一为 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
 */
/** 一次旁路会话创建请求。 */
export interface SideAskRequest {
    /** 父会话 id（当前主会话）。 */
    readonly parentSessionId: string;
    /**
     * 预留：继承边界。当前 host 侧不使用——`sessions.fork` 的 boundary
     * 是 events 数组索引（且要求 `events[i].seq === i`），不是 seq，
     * 直接透传会抛 INVALID_BOUNDARY。传了也不会生效。
     */
    readonly atSeq?: number;
    /** 子会话预设；省略沿用父会话预设。 */
    readonly agentPreset?: string;
    readonly cwd?: string;
    /**
     * 建好后立即投递的第一条提问。
     * 追问场景传「引用 + 问题」；复盘场景传复盘提示词。
     * 不传则开一个空会话，由用户自己起头。
     */
    readonly firstMessage?: string;
}
/** 创建成功后的结果。 */
export interface SideAskResult {
    readonly sessionId: string;
    readonly inheritedEventCount: number;
    readonly agentPreset: string;
    /** 落盘状态。false 时侧栏一发送就会报 not found，必须让用户看见。 */
    readonly persist?: {
        readonly ok: boolean;
        readonly error?: string;
    };
}
/** 打开右侧栏旁路会话 tab 的函数（由 sideAskTab 提供）。 */
export type OpenSideAsk = (sessionId: string) => void;
/** 复盘会话的创建请求。 */
export interface ReviewSessionRequest {
    /** 要被复盘的会话 id。 */
    readonly targetSessionId: string;
    /** 复盘会话自己的工作目录（必须是绝对路径）。 */
    readonly cwd: string;
    /** 复盘预设；省略用 host 侧默认的 session-review。 */
    readonly agentPreset?: string;
}
/** 复盘会话的创建结果。 */
export interface ReviewSessionResult {
    readonly sessionId: string;
    readonly agentPreset: string;
    /** 注入给复盘的轮次数，便于提示用户数据量。 */
    readonly digestTurns: number;
}
export interface SideAskClient {
    /**
     * 创建旁路会话（fork 当前会话，继承对话）并在右侧栏打开它。
     *
     * @param request - 父会话、继承边界、预设。
     * @returns 子会话信息；失败时抛错，`code` 说明原因。
     */
    openSideSession(request: SideAskRequest): Promise<SideAskResult>;
    /**
     * 开一个只读复盘会话。
     *
     * 与 `openSideSession` 的关键差别：**不 fork**，而是新开会话并指定只读预设
     * （这样只读才是真的），过程数据由 host 从会话日志文件读出来注入。
     */
    openReviewSession(request: ReviewSessionRequest): Promise<ReviewSessionResult>;
}
/** RPC 失败时抛出，带 host 给的稳定 code。 */
export declare class SideAskError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** 把人类可读的原因映射给用户看。 */
export declare function describeSideAskError(error: unknown): string;
/** 构造旁路会话客户端。 */
export declare function createSideAskClient(deps: {
    openSideAsk?: OpenSideAsk;
}): SideAskClient;
