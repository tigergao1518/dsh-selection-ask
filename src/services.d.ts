import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * host 半用到的官方服务，其类型声明分散在各自的包里
 * （`@deepseek-ai/dsh-webserver`、`@deepseek-ai/dsh-agent` 等）。
 * 这些包没有作为本项目的编译依赖引入——插件在宿主里运行，
 * 只需要运行时服务存在——所以在这里做最小声明扩展，
 * 让 `ctx.webServer` / `ctx.sessions` / `ctx.agents` 有类型可查。
 *
 * 声明与 asar 里的真实签名逐条对齐：
 *   - WebRoute      { kind: 'exact' | 'prefix', path, handler }
 *   - sessions.fork(source, boundary?, childSessionId?)
 *   - agents.create(options) → AgentHandle { agent, dispose() }
 */

/** `@deepseek-ai/dsh-webserver` 暴露的服务面。 */
interface DshWebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** `@deepseek-ai/dsh-session` 暴露的会话存储面（本插件只用得到 fork/get）。 */
interface DshSessionsService {
  get(id: string): DshSession | undefined
  /**
   * 派生子会话。
   *
   * `boundary` 是 events 的**数组索引**，且须满足 `events[i].seq === i`，
   * 不是任意 seq；传错抛 INVALID_BOUNDARY。省略表示继承到源会话最新一条。
   *
   * `childSessionId` 强烈建议显式传入：省略时走 host 自增 `session-N`，
   * 那个计数器只与内存 store 对账，磁盘上已持久化的旧会话不参与，
   * 重启后易撞车（实测 `session "session-2" already exists`）。
   */
  fork(
    source: DshSession | string,
    boundary?: number,
    childSessionId?: string,
  ): DshSession
}

/** `@deepseek-ai/dsh-session` 的 Session（本插件读几个字段 + append 首条消息）。 */
interface DshSession {
  readonly id: string
  readonly header?: {
    readonly cwd?: string
    readonly parentSession?: string
    readonly agentPreset?: string
  }
  readonly inheritedEventCount?: number
  /**
   * 追加一条事件。
   * `user/message` 的 data 直接是 UserMessage 本身
   * （`{ id, role: 'user', source: { kind: 'user' }, content: [...] }`），
   * opts 需给 `{ surfaceOp: 'append' }` 才进「模型可见」的对话流水面。
   */
  append(type: string, data: unknown, opts?: unknown): unknown
  /** 取事件快照（fork 落盘时用它把 seed 事件写进持久化层）。 */
  snapshotEvents(from?: number): readonly unknown[]
  /**
   * 最近一次模型请求的头，其中 `config` 就是 agent loop 解析 `{{model}}`
   * 与模型路由用的 provider/model。**从未请求过模型的会话没有请求头**，
   * 返回 undefined——新建的旁路会话正是这种情况，所以模型路由必须另找来源。
   */
  requestHeader?():
    | { config?: { readonly provider?: string; readonly model?: string } }
    | undefined
}

/**
 * `@deepseek-ai/dsh-agent` 暴露的 agent 注册表面。
 *
 * ⚠️ `create` 有个必须避开的陷阱：它内部第一步就是
 * `sessions.prepare(options.sessionId, …)`，而 prepare 对**已在 store 里**
 * 的 id 直接抛 `session "…" already exists`。所以「先 fork 建会话、
 * 再 create 建 agent」必然失败。已存在的会话只能走 `resume`（从持久化恢复），
 * 或者干脆不建 agent、交给宿主按需建立（本插件的选择）。
 */
interface DshAgentsService {
  get(id: string): DshAgent | undefined
  create(options: {
    sessionId: string
    /**
     * AgentOptions，**新建会话必须给**。
     *
     * agent loop 只在「配置 / 会话请求头 / agent.options」三处找
     * provider/model，新会话前两者都是空的，不给就一发消息就撞
     *   agent "…" has no provider/model: set AgentOptions.provider and
     *   AgentOptions.model or supply both via the agent/request waterfall
     *
     * 注意字段名是 `agentOptions`（一个嵌套对象），**不是**顶层的
     * provider / model——官方 headless runner 的调用是
     *   agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model }, setup })
     * 写成顶层字段不会报错，但也不会生效，问题会在发送时才暴露。
     */
    agentOptions?: { readonly provider?: string; readonly model?: string }
    /** 只用来建立归属关系，本插件不会拿它调方法，所以按最小面声明。 */
    parentAgent?: { readonly id: string }
    meta?: {
      cwd?: string
      parentSession?: string
      isSeeded?: boolean
      origin?: 'subagent'
      delegationDepth?: number
      agentPreset?: string
    }
    inheritedEventCount?: number
    seed?: readonly unknown[]
  }): Promise<DshAgentHandle>
}

/** `@deepseek-ai/dsh-agent` 的 Agent（本插件只用来判断存活、取 id、投首条消息）。 */
interface DshAgent {
  readonly id: string
  /**
   * AgentOptions。旁路会话要沿用父会话的模型，就从这里取 provider/model
   * （agent loop 的解析瀑布里它排在会话请求头之后）。
   */
  readonly options?: { readonly provider?: string; readonly model?: string }
  /**
   * 投递一条用户消息到 inbox。
   * target: 'next-turn'（排在本轮之后）/ 'next-step'；
   * wakeup: true 让 agent 立即开始处理。
   */
  send(
    message: { role: 'user'; content: Array<{ type: 'text'; text: string }> },
    target: 'next-turn' | 'next-step',
    wakeup: boolean,
  ): void
}

/** `agents.create` 的返回。 */
interface DshAgentHandle {
  agent: DshAgent
  dispose(): Promise<void>
}

/**
 * `@deepseek-ai/dsh-subagents` 暴露的子代理投递面。
 *
 * `queuePrompt` 是官方为「把人写的提问排进一个直接子会话」设计的入口：
 * 内部「活跃就投进 inbox，不活跃就 cold resume」，因此**不需要**调用方
 * 预先建立子 agent——这正是旁路会话能「只 fork、不建 agent」的依据。
 */
interface DshSubagentsService {
  queuePrompt(
    parent: DshAgent,
    childId: string,
    content: readonly { type: 'text'; text: string }[],
    source: { kind: 'user' },
    signal?: AbortSignal,
  ): Promise<string>
}

/**
 * `@deepseek-ai/dsh-session-persistence` 暴露的持久化面。
 *
 * 关键：`sessions.fork` **不会**调它——fork 只把子会话放进内存 store。
 * 所以 fork 出的旁路会话必须自己 create 一次才能落盘，否则任何从磁盘
 * 打开它的路径（coldResume、重启恢复、侧栏发送消息）都会抛
 * `SessionPersistenceNotFoundError`。
 */
interface DshSessionPersistence {
  create(
    header: unknown,
    options?: { inheritedEventCount?: number; signal?: AbortSignal },
  ): Promise<{
    append(events: readonly unknown[], options?: { signal?: AbortSignal }): Promise<void>
    flush(options?: { signal?: AbortSignal }): Promise<void>
    close(): Promise<void>
  }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: DshWebServerService
    sessions: DshSessionsService
    agents: DshAgentsService
    subagents: DshSubagentsService
    sessionPersistence: DshSessionPersistence
  }
}
