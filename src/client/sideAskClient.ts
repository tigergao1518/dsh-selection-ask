/**
 * 浏览器半的旁路会话客户端。
 *
 * 静态客户端插件没有 `host.call`，所以与宿主半通信走所有出厂插件都在用的
 * 那条路：同源 POST 到 host 注册的 `/dsh-side-ask/rpc`。
 * 信封统一为 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。
 */

/** host 半路由，与 `src/sideAskRpc.ts` 的 ROUTE_PATH 一致。 */
const RPC_PATH = '/dsh-side-ask/rpc'

/** 一次旁路会话创建请求。 */
export interface SideAskRequest {
  /** 父会话 id（当前主会话）。 */
  readonly parentSessionId: string
  /**
   * 预留：继承边界。当前 host 侧不使用——`sessions.fork` 的 boundary
   * 是 events 数组索引（且要求 `events[i].seq === i`），不是 seq，
   * 直接透传会抛 INVALID_BOUNDARY。传了也不会生效。
   */
  readonly atSeq?: number
  /** 子会话预设；省略沿用父会话预设。 */
  readonly agentPreset?: string
  readonly cwd?: string
  /**
   * 建好后立即投递的第一条提问。
   * 追问场景传「引用 + 问题」；复盘场景传复盘提示词。
   * 不传则开一个空会话，由用户自己起头。
   */
  readonly firstMessage?: string
}

/** 创建成功后的结果。 */
export interface SideAskResult {
  readonly sessionId: string
  readonly inheritedEventCount: number
  readonly agentPreset: string
  /** 落盘状态。false 时侧栏一发送就会报 not found，必须让用户看见。 */
  readonly persist?: { readonly ok: boolean; readonly error?: string }
}

/** 打开右侧栏旁路会话 tab 的函数（由 sideAskTab 提供）。 */
export type OpenSideAsk = (sessionId: string) => void

/** 复盘会话的创建请求。 */
export interface ReviewSessionRequest {
  /** 要被复盘的会话 id。 */
  readonly targetSessionId: string
  /** 复盘会话自己的工作目录（必须是绝对路径）。 */
  readonly cwd: string
  /** 复盘预设；省略用 host 侧默认的 session-review。 */
  readonly agentPreset?: string
}

/** 复盘会话的创建结果。 */
export interface ReviewSessionResult {
  readonly sessionId: string
  readonly agentPreset: string
  /** 注入给复盘的轮次数，便于提示用户数据量。 */
  readonly digestTurns: number
}

export interface SideAskClient {
  /**
   * 创建旁路会话（fork 当前会话，继承对话）并在右侧栏打开它。
   *
   * @param request - 父会话、继承边界、预设。
   * @returns 子会话信息；失败时抛错，`code` 说明原因。
   */
  openSideSession(request: SideAskRequest): Promise<SideAskResult>

  /**
   * 开一个只读复盘会话。
   *
   * 与 `openSideSession` 的关键差别：**不 fork**，而是新开会话并指定只读预设
   * （这样只读才是真的），过程数据由 host 从会话日志文件读出来注入。
   */
  openReviewSession(request: ReviewSessionRequest): Promise<ReviewSessionResult>
}

/** RPC 失败时抛出，带 host 给的稳定 code。 */
export class SideAskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SideAskError'
  }
}

/** 把人类可读的原因映射给用户看。 */
export function describeSideAskError(error: unknown): string {
  if (error instanceof SideAskError) {
    switch (error.code) {
      case 'parent-not-found':
        return '找不到当前会话，可能已关闭'
      case 'parent-not-live':
        return '当前会话已归档，无法继承它的上下文'
      case 'forbidden':
        return '请求被拒绝（非本机来源）'
      case 'not-confirmed':
        return '创建请求未获确认'
      case 'bad-request':
        return `请求参数有误：${error.message}`
      default:
        return error.message || '创建旁路会话失败'
    }
  }
  return error instanceof Error ? error.message : '创建旁路会话失败'
}

/** 构造旁路会话客户端。 */
export function createSideAskClient(deps: { openSideAsk?: OpenSideAsk }): SideAskClient {
  /** 统一的 RPC 调用：发请求、解信封、把错误转成 SideAskError。 */
  async function call(method: string, params: Record<string, unknown>): Promise<any> {
    let payload: any
    try {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 同源请求必须带 cookie，否则宿主认不出来源。
        credentials: 'same-origin',
        // confirm: true 是所有创建方法的门禁（host 侧强制）。
        body: JSON.stringify({ method, params: { ...params, confirm: true } }),
      })
      payload = await response.json()
    } catch (error) {
      throw new SideAskError('network', error instanceof Error ? error.message : String(error))
    }
    if (payload?.ok !== true) {
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'internal'
      const message = typeof payload?.error?.message === 'string' ? payload.error.message : ''
      throw new SideAskError(code, message)
    }
    return payload.value ?? {}
  }

  return {
    async openSideSession(request: SideAskRequest): Promise<SideAskResult> {
      const value = await call('createSideSession', {
        parentSessionId: request.parentSessionId,
        ...(request.atSeq === undefined ? {} : { atSeq: request.atSeq }),
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.firstMessage === undefined || request.firstMessage === ''
          ? {}
          : { firstMessage: request.firstMessage }),
      })

      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
      if (sessionId === '') throw new SideAskError('internal', '宿主未返回子会话 id')

      // 会话已建好，剩下就是把它显示出来。右侧栏服务不全是降级路径：
      // 会话不会丢，只是不在侧栏打开。
      deps.openSideAsk?.(sessionId)

      return {
        sessionId,
        inheritedEventCount: Number(value.inheritedEventCount ?? 0),
        agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : '',
        persist:
          value.persist !== undefined && typeof value.persist === 'object'
            ? {
                ok: value.persist.ok === true,
                error: typeof value.persist.error === 'string' ? value.persist.error : undefined,
              }
            : undefined,
      }
    },

    async openReviewSession(request: ReviewSessionRequest): Promise<ReviewSessionResult> {
      const value = await call('openReviewSession', {
        targetSessionId: request.targetSessionId,
        cwd: request.cwd,
        ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
      })

      const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
      if (sessionId === '') throw new SideAskError('internal', '宿主未返回复盘会话 id')

      deps.openSideAsk?.(sessionId)

      return {
        sessionId,
        agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : '',
        digestTurns: Number(value.digestTurns ?? 0),
      }
    },
  }
}
