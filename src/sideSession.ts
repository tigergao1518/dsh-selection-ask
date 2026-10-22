import type { Context } from '@deepseek-ai/cordis'

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
  readonly sessionId: string
  /** 从父会话复制了多少个事件（客户端可用来标注「继承到第几轮」）。 */
  readonly inheritedEventCount: number
  /** 子会话实际使用的预设 id。 */
  readonly agentPreset: string
  /**
   * 落盘结果。**必须检查这个字段**：host 的 console 输出不会进浏览器
   * 控制台，所以落盘失败只能靠这个字段暴露给用户和诊断。
   */
  readonly persist: { readonly ok: boolean; readonly error?: string }
}

/** 创建旁路会话的入参。 */
export interface CreateSideSessionRequest {
  /**
   * 父会话 id（主会话）。**fork 路必填**（追问要继承它的对话）；
   * 新开会话路不需要（复盘不继承对话，只读日志）。
   */
  readonly parentSessionId?: string
  /**
   * 预留：继承边界。
   *
   * 当前**不使用** —— `sessions.fork` 的 boundary 是 events 的数组索引
   * （且要求 `events[i].seq === i`），不是任意 seq，直接透传用户 seq
   * 会抛 INVALID_BOUNDARY。现在两个入口都继承到「最新一条」（省略 boundary），
   * 已满足需求；将来要按轮次截取，需要先由 host 把 seq 换算成索引。
   */
  readonly atSeq?: number
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
  readonly agentPreset?: string
  /** 子会话的 cwd。fork 路省略则沿用父会话；新开会话路必填。 */
  readonly cwd?: string
  /**
   * 授权方 agent（新开会话路用）。
   * 设了它，会话就挂在这个 agent 名下；复盘场景不设，保持独立。
   * 类型用结构化的最小面，避免依赖 services.d.ts 里的全局声明名。
   */
  readonly parentAgent?: { readonly id: string }
  /**
   * 建好后立即投递的第一条提问。
   * 追问场景传「引用 + 用户的问题」，复盘场景传「复盘提示词 + 会话过程数据」，
   * 于是用户点一下就能用，不用再手动粘贴一遍。
   */
  readonly firstMessage?: string
  /**
   * 子会话的模型路由。**新开会话路（复盘）必填**：那条路没有父会话可继承，
   * 而 agent loop 只在「配置 / 会话请求头 / AgentOptions」三处找 provider/model，
   * 新会话前两者都是空的，不给就一发消息就撞
   *   agent "…" has no provider/model
   * 追问路不需要传——它会自己从父会话解析（见 resolveRoute）。
   */
  readonly route?: AgentRoute
}

/** 旁路会话工厂抛出的错误，都带 `code`，客户端据此给提示。 */
export class SideSessionError extends Error {
  constructor(
    readonly code:
      | 'parent-not-found'
      | 'parent-not-live'
      | 'preset-unknown'
      | 'create-failed',
    message: string,
  ) {
    super(message)
    this.name = 'SideSessionError'
  }
}

/** 默认预设：追问场景沿用父会话预设，由调用方显式决定。 */
export const DEFAULT_SIDE_PRESET = 'session-review'

/** 一条可用的模型路由。 */
export interface AgentRoute {
  readonly provider: string
  readonly model: string
}

/** 带 `options` 的对象的最小面（Agent 就是这种）。 */
interface OptionsCarrier {
  readonly options?: { readonly provider?: unknown; readonly model?: unknown }
}

/** 带 `requestHeader()` 的对象的最小面（Session 就是这种）。 */
interface HeaderCarrier {
  readonly requestHeader?: () => unknown
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * 从 AgentOptions 上取 provider/model。
 *
 * agent loop 的 provider/model 解析瀑布是
 *   configured ?? session.requestHeader()?.config ?? agent.options
 * 前两级都可能为空（没配 summarization、从没请求过模型），所以这里把它
 * 单独拿出来当一个来源。
 */
function routeFromOptions(holder: unknown): AgentRoute | undefined {
  if (holder === null || typeof holder !== 'object') return undefined
  const { provider, model } = (holder as OptionsCarrier).options ?? {}
  if (isNonEmptyString(provider) && isNonEmptyString(model)) {
    return { provider, model }
  }
  return undefined
}

/** 从 Session 的请求头取 provider/model（最近一次模型请求用的路由）。 */
function routeFromSession(session: unknown): AgentRoute | undefined {
  if (session === null || typeof session !== 'object') return undefined
  const requestHeader = (session as HeaderCarrier).requestHeader
  if (typeof requestHeader !== 'function') return undefined
  const header = requestHeader.call(session) as
    | { config?: { provider?: unknown; model?: unknown } }
    | undefined
  const { provider, model } = header?.config ?? {}
  if (isNonEmptyString(provider) && isNonEmptyString(model)) {
    return { provider, model }
  }
  return undefined
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
export function resolveRoute(
  agent: unknown,
  session?: unknown,
): AgentRoute | undefined {
  return routeFromSession(session) ?? routeFromOptions(agent)
}

/**
 * 生成旁路会话 id。
 *
 * 不用 host 自增的 `session-N`：那个计数器只与内存 store 对账，
 * 而磁盘上已持久化的旧会话不参与，进程重启后计数器归零就会撞上
 * 尚未加载的同名会话（实测 `session "session-2" already exists`）。
 * 这里用时间戳+随机数，并加 `side` 前缀便于在会话列表里识别来源。
 */
function nextSideSessionId(): string {
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 8)
  return `session-side-${stamp}-${salt}`
}

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
export function mountSideSessionFactory(ctx: Context): (
  request: CreateSideSessionRequest,
) => Promise<SideSessionRecord> {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')

  return async function createSideSession(
    request: CreateSideSessionRequest,
  ): Promise<SideSessionRecord> {
    if (sessions === undefined || typeof sessions.fork !== 'function') {
      throw new SideSessionError('create-failed', 'sessions 服务不可用')
    }
    // agents 只用来判断父会话是否还活着（活着的父会话才有预设/模型可继承）。
    if (agents === undefined || typeof agents.get !== 'function') {
      throw new SideSessionError('create-failed', 'agents 服务不可用')
    }

    // 1. 解析父会话。fork 接受 id，但我们需要父 agent 来继承预设与模型，
    //    所以先取一次。
    const parentSessionId = request.parentSessionId
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new SideSessionError('parent-not-found', 'fork 路必须给 parentSessionId')
    }
    const parent = sessions.get(parentSessionId)
    if (parent === undefined) {
      throw new SideSessionError(
        'parent-not-found',
        `父会话不存在或已退出：${parentSessionId}`,
      )
    }
    const parentAgent = agents.get(parent.id)
    if (parentAgent === undefined) {
      throw new SideSessionError(
        'parent-not-live',
        '父会话没有活动的 agent（可能已归档），无法继承其预设与模型',
      )
    }

    // 2. 子会话预设 = 继承父会话的。
    //    这不是「可选项」而是事实：fork 的 meta 不接受 agentPreset，
    //    事后又无法切换（官方对已开始的会话抛 agent-preset/locked）。
    //    详见 CreateSideSessionRequest.agentPreset 的注释。
    const agentPreset =
      request.agentPreset ?? parent.header?.agentPreset ?? DEFAULT_SIDE_PRESET

    // 3. 造子会话：**自己构造 seed，走 `agents.create`，不再用 fork。**
    //
    //    这条路是三次报错换来的，每一步都有实测依据：
    //
    //    (1) 0.3.0/0.3.1「session … already exists」——当时以为是 id 撞车，
    //        实际是 fork 之后又调 agents.create，prepare 对 store 里已有的
    //        同 id 抛 already exists。于是改成「只 fork 不建 agent」。
    //
    //    (2) 但 fork 只走 `prepare → enter → announce`，**从不落盘**。
    //        侧栏一发送就报 `SessionPersistenceNotFoundError`（not found）。
    //
    //    (3) 自己补 `persistence.create` 落盘，又报 `already exists`——
    //        因为 resume 路径上 `registerCreated` 撞上我注册过的 writer：
    //          `if (this.writers.has(header.id)) throw new SessionAlreadyExistsError(...)`
    //        而 `session/flush` 救不了（它的 listener 是
    //          `if (writers.get(id) === undefined) return`，没 writer 就空转）。
    //
    //    (4) 而且 sessionPersistence 被 isolate 隔离，第三方插件 fiber 拿不到
    //        （不在 Cordis Inspect 目录里），属性访问还会抛
    //        `cannot get property … without inject`。
    //
    //    **正解**：`agents.create` 的参数结构与 `sessions.create` 几乎一样
    //    （都收 seed / inheritedEventCount / meta），而它内部
    //      `createStoredSession → persistence.create(header)`
    //    一步同时完成「进 store + 落盘 + 拿 write 所有权」。
    //    没有 fork，就没有后面的重复 create，两个 already exists 都不存在。
    //    复盘路（createFreshSession）一直是这么走的，已验证可落盘、可发送。
    //
    //    seed 构造复刻官方 `buildForkSeed`（读 app.asar 确认）：
    //      父会话 events[0..boundary] + 一条 session/end-seed。
    //    唯一没复刻的是 `openTurnClosers`：它只对「父会话正在跑 turn」有意义，
    //    给未收尾的 turn 补 closer。用户是读完再选中，父会话通常空闲，
    //    此时它返回空数组，不带没有影响；真遇到正在跑的父会话，
    //    恢复时 DSH 会按「轮次中途崩溃」处理（它本就有这套修复逻辑）。
    const childSessionId = nextSideSessionId()
    // snapshotEvents 的返回类型是 unknown[]，这里只需要 seq 与 time 两个字段，
    // 所以先收窄成最小结构再用。
    const parentEvents = parent.snapshotEvents() as readonly { seq?: unknown; time?: unknown }[]
    const lastEvent = parentEvents.at(-1)
    const boundary = typeof lastEvent?.seq === 'number' ? lastEvent.seq : -1
    const seed: unknown[] = []
    if (boundary >= 0) {
      seed.push(...parentEvents.slice(0, boundary + 1))
      seed.push({
        type: 'session/end-seed',
        seq: boundary + 1,
        time: lastEvent?.time,
        data: { inherited: true },
      })
    }

    // 模型路由：沿用父会话的（请求头优先，其次父 agent 的 options）。
    // 必须显式传给 agents.create——见 resolveRoute 的说明。
    // 拿不到就拒绝建会话：建一个发不出消息的旁路会话没有价值，
    // 而且会让用户在原处再撞一次同一句报错。
    const route = resolveRoute(parentAgent, parent)
    if (route === undefined) {
      throw new SideSessionError(
        'create-failed',
        '父会话还没有可用的模型路由（provider/model）。请先在主会话发一条消息，' +
          '让模型请求建立起来，再开侧边栏追问。',
      )
    }

    const created = await agents.create({
      sessionId: childSessionId,
      // provider/model 必须包在 agentOptions 里，**不是顶层字段**。
      // 官方 headless runner 就是这么调的：
      //   agents.create({ sessionId, meta: { cwd }, agentOptions: { provider, model }, setup })
      // agent loop 取模型的瀑布末级正是 agent.options，它由这里注入。
      agentOptions: { provider: route.provider, model: route.model },
      meta: {
        ...parent.header?.cwd !== undefined ? { cwd: parent.header.cwd } : {},
        parentSession: parent.id,
        isSeeded: true,
      },
      seed,
      inheritedEventCount: boundary + 1,
    })
    const childId = created.agent.id

    // agents.create 内部已落盘，不需要（也不能）再碰 persistence。
    const persist = { ok: true as const }

    // 5. **不投递首条消息**。
    //
    //    曾经用 subagents.queuePrompt 把「引用 + 问题」直接发出去，
    //    但用户要的是「带进输入框、由我自己决定何时发」。
    //    所以这里只返回 sessionId，文本由浏览器半通过
    //    `pendingSideDrafts` 预填到子会话的 composer（见 sideAskStore.ts）。
    //
    //    （queuePrompt 这条路也留着备用：调用方显式传 firstMessage 时才走，
    //    比如将来要做「一键发起并自动跑」的场景。）
    const firstMessage = request.firstMessage?.trim()
    if (firstMessage !== undefined && firstMessage !== '') {
      const subagents = ctx.get('subagents')
      if (subagents !== undefined && typeof subagents.queuePrompt === 'function') {
        try {
          await subagents.queuePrompt(
            parentAgent,
            childId,
            [{ type: 'text', text: firstMessage }],
            // 归属成「人说的」：这样它进用户对话流，而不是被当成插件注入。
            { kind: 'user' },
            undefined,
          )
        } catch {
          // 投递失败不该作废整个旁路会话：会话已经建好并落盘，
          // 用户在右侧栏里手动问一句即可。只吞掉，不往外抛。
        }
      }
    }

    return {
      sessionId: childId,
      inheritedEventCount: boundary + 1,
      agentPreset,
      persist,
    }
  }
}

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
export function mountFreshSessionFactory(ctx: Context): (
  request: CreateSideSessionRequest,
) => Promise<SideSessionRecord> {
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')

  return async function createFreshSession(
    request: CreateSideSessionRequest,
  ): Promise<SideSessionRecord> {
    if (sessions === undefined || agents === undefined || typeof agents.create !== 'function') {
      throw new SideSessionError('create-failed', 'sessions/agents 服务不可用')
    }
    // cwd 必须给：会话 header 的 cwd 是非空绝对路径，缺了会被 prepare 拒绝。
    const cwd = request.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      throw new SideSessionError(
        'create-failed',
        '新开会话需要 cwd（复盘会话要有自己的工作目录）',
      )
    }

    const sessionId = nextSideSessionId()
    const agentPreset = request.agentPreset ?? DEFAULT_SIDE_PRESET

    const handle = await agents.create({
      sessionId,
      parentAgent: request.parentAgent,
      // provider/model 包在 agentOptions 里（同 createSideSession，见那里的说明）。
      ...(request.route !== undefined
        ? { agentOptions: { provider: request.route.provider, model: request.route.model } }
        : {}),
      meta: {
        cwd,
        // parentSession 不设：复盘会话是独立会话，不该挂进父会话的谱系
        // （挂进去会被当成子代理会话，在会话列表里被归到父会话下）。
        agentPreset,
      },
    })
    if (handle === undefined) {
      throw new SideSessionError('create-failed', '新会话创建失败')
    }

    const firstMessage = request.firstMessage?.trim()
    if (firstMessage !== undefined && firstMessage !== '') {
      try {
        // 会话刚创建就有活 agent，直接用 inbox 投递即可。
        handle.agent.send(
          { role: 'user', content: [{ type: 'text', text: firstMessage }] },
          'next-turn',
          true,
        )
      } catch {
        // 投递失败不作废会话：用户可以在新会话里自己问。
      }
    }

    // 复盘路走 agents.create，它内部有 createStoredSession 负责落盘，
    // 所以这里报 ok。真出问题的话 create 本身会抛错，不会走到这里。
    return { sessionId, inheritedEventCount: 0, agentPreset, persist: { ok: true } }
  }
}
