import type { Context } from '@deepseek-ai/cordis';
/**
 * 旁路会话工厂 —— dsh-selection-ask 的 host 半核心。
 *
 * 「旁路会话」是这套插件的中心概念：它是一次性的子会话，
 * 继承主会话到某一轮为止的上下文，但有自己的 agent、自己的预设、
 * 自己的对话流。主会话既不会被打断，也不会被旁路会话的内容污染。
 *
 * 两个入口共用这一个工厂：
 *   - 选中追问：继承到「选中文本所在轮」，问题来自用户输入；
 *   - 会话复盘：继承到「当前最后一轮」，预设换成 session-review（只读），
 *     第一个问题由插件预填。
 *
 * 实现上完全走官方接口，不碰任何内部结构：
 *   - `ctx.sessions.fork(source, boundary)` 复制前缀得到子 Session；
 *   - `ctx.agents.create({ sessionId, parentAgent, meta, ... })` 建子 Agent，
 *     `meta.agentPreset` 决定子会话用哪套工具与人格。
 */
/** 一次旁路会话的创建结果。 */
export interface SideSessionRecord {
    /** 子会话 id，客户端用它打开右侧栏 tab。 */
    readonly sessionId: string;
    /** 从父会话复制了多少个事件（客户端可用来标注「继承到第几轮」）。 */
    readonly inheritedEventCount: number;
    /** 子会话实际使用的预设 id。 */
    readonly agentPreset: string;
    /**
     * 落盘结果。**必须检查这个字段**：host 的 console 输出不会进浏览器
     * 控制台，所以落盘失败只能靠这个字段暴露给用户和诊断。
     */
    readonly persist: {
        readonly ok: boolean;
        readonly error?: string;
    };
}
/** 创建旁路会话的入参。 */
export interface CreateSideSessionRequest {
    /**
     * 父会话 id（主会话）。**fork 路必填**（追问要继承它的对话）；
     * 新开会话路不需要（复盘不继承对话，只读日志）。
     */
    readonly parentSessionId?: string;
    /**
     * 预留：继承边界。
     *
     * 当前**不使用** —— `sessions.fork` 的 boundary 是 events 的数组索引
     * （且要求 `events[i].seq === i`），不是任意 seq，直接透传用户 seq
     * 会抛 INVALID_BOUNDARY。现在两个入口都继承到「最新一条」（省略 boundary），
     * 已满足需求；将来要按轮次截取，需要先由 host 把 seq 换算成索引。
     */
    readonly atSeq?: number;
    /**
     * 子会话预设。
     *
     * 行为取决于走哪条路（两者语义不同，调用方要清楚）：
     *
     * - **fork 路**（追问入口）：**无法生效**。`sessions.fork` 的 meta 只有
     *   cwd/parentSession/isSeeded，不接受 agentPreset；事后想改又被官方
     *   `agent-preset/locked` 拒（会话一旦开始过就不能切）。所以 fork 出的
     *   子会话预设**继承自父会话**，这个字段只影响返回值回显。
     *
     * - **新开会话路**（复盘入口，mountFreshSessionFactory）：**真正生效**。
     *   新 id 不在 store 里，`agents.create({ meta: { agentPreset } })` 能一步
     *   把预设定下来，于是复盘会话真的用只读工具集。
     */
    readonly agentPreset?: string;
    /** 子会话的 cwd。fork 路省略则沿用父会话；新开会话路必填。 */
    readonly cwd?: string;
    /**
     * 授权方 agent（新开会话路用）。
     * 设了它，会话就挂在这个 agent 名下；复盘场景不设，保持独立。
     * 类型用结构化的最小面，避免依赖 services.d.ts 里的全局声明名。
     */
    readonly parentAgent?: {
        readonly id: string;
    };
    /**
     * 建好后立即投递的第一条提问。
     * 追问场景传「引用 + 用户的问题」，复盘场景传「复盘提示词 + 会话过程数据」，
     * 于是用户点一下就能用，不用再手动粘贴一遍。
     */
    readonly firstMessage?: string;
    /**
     * 子会话的模型路由。**新开会话路（复盘）必填**：那条路没有父会话可继承，
     * 而 agent loop 只在「配置 / 会话请求头 / AgentOptions」三处找 provider/model，
     * 新会话前两者都是空的，不给就一发消息就撞
     *   agent "…" has no provider/model
     * 追问路不需要传——它会自己从父会话解析（见 resolveRoute）。
     */
    readonly route?: AgentRoute;
}
/** 旁路会话工厂抛出的错误，都带 `code`，客户端据此给提示。 */
export declare class SideSessionError extends Error {
    readonly code: 'parent-not-found' | 'parent-not-live' | 'preset-unknown' | 'create-failed';
    constructor(code: 'parent-not-found' | 'parent-not-live' | 'preset-unknown' | 'create-failed', message: string);
}
/** 默认预设：追问场景沿用父会话预设，由调用方显式决定。 */
export declare const DEFAULT_SIDE_PRESET = "session-review";
/** 一条可用的模型路由。 */
export interface AgentRoute {
    readonly provider: string;
    readonly model: string;
}
/**
 * 解析子会话该用的模型路由。
 *
 * **为什么必须显式传给 `agents.create`**：agent loop 拿 provider/model 的瀑布
 * 只有三处——配置、会话请求头、`AgentOptions`。旁路会话由 `agents.create`
 * 全新创建，既没有请求头（从未请求过模型），创建时又没给 options，两级都是
 * `undefined`，于是用户一发送就撞：
 *   agent "…" has no provider/model: set AgentOptions.provider and
 *   AgentOptions.model or supply both via the agent/request waterfall
 *
 * 取值顺序刻意与官方瀑布一致：请求头优先（它反映的是「最近实际用的模型」，
 * 最贴近「追问沿用主会话的模型」这个语义），拿不到再退回 agent 的 options。
 *
 * 返回 undefined 表示两侧都空——调用方应当拒绝建会话，而不是建一个
 * 发不出消息的会话让用户撞同一句报错。
 */
export declare function resolveRoute(agent: unknown, session?: unknown): AgentRoute | undefined;
/**
 * `persistForkedChild` 需要的子会话最小面。
 *
 * 用结构化类型而不是 services.d.ts 里的 DshSession：那个文件顶部有
 * `import type`，整体是个模块，其内部接口不是全局声明、无法跨文件引用。
 */
/**
 * 挂载旁路会话工厂。
 *
 * @param ctx - 需要 `sessions` 与 `agents` 两个 host 服务。
 * @returns 创建函数；宿主进程重启后不保留（旁路会话本身是持久会话，
 *   只是「父 → 子」的活引用关系随进程生命周期，重启后从侧栏列表仍可找到子会话）。
 */
export declare function mountSideSessionFactory(ctx: Context): (request: CreateSideSessionRequest) => Promise<SideSessionRecord>;
/**
 * 开一个**全新的会话**（不 fork 父会话），并指定它自己的预设。
 *
 * 复盘走这条路，理由是 fork 那条路让只读预设无法生效（详见
 * {@link CreateSideSessionRequest.agentPreset} 的注释）。新会话的 id 不在
 * store 里，所以 `agents.create` 不会撞 already exists，`meta.agentPreset`
 * 能真正定下这个会话的工具集与人格。
 *
 * 代价是没有父会话的对话继承——复盘本来也不需要：它要的是**过程数据**，
 * 而过程数据由调用方以首条消息注入（提炼自会话日志文件）。
 *
 * @param ctx - host 上下文。
 * @returns 创建函数。
 */
export declare function mountFreshSessionFactory(ctx: Context): (request: CreateSideSessionRequest) => Promise<SideSessionRecord>;
