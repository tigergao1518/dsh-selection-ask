import type { IncomingMessage, ServerResponse } from 'node:http'

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
export const ROUTE_PATH = '/dsh-side-ask/rpc'

/** 请求体上限：每个请求都只是一小段 JSON。 */
const MAX_BODY_BYTES = 64 * 1024

/** 需要一个显式 `confirm: true` 才执行的方法（会新建 agent、消耗额度）。 */
const NEEDS_CONFIRM = new Set(['createSideSession', 'openReviewSession'])

/** 写一个信封。 */
function json(res: ServerResponse, envelope: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

/** 读取 JSON 请求体，不可用时返回 null。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) {
      req.destroy?.()
      return null
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 判断 IPv4/IPv6 字面量是否为回环地址。 */
function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return isLoopbackAddress(address.slice(7))
  const parts = address.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part)) &&
    parts[0] === '127'
  )
}

/** 判断主机名是否指向本机。 */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''))
}

/**
 * 回环防护。插座地址才是权威，`X-Forwarded-For` 一律不采信。
 * 这条路由能创建 agent，所以局域网 peer 即使在受信宿主部署下也不该够到它。
 */
export function isLoopbackRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 路由处理函数的依赖。 */
export interface SideAskRpcDeps {
  /** 旁路会话工厂（fork 父会话，用于选中追问）。 */
  readonly createSideSession: (request: {
    parentSessionId: string
    atSeq?: number
    agentPreset?: string
    cwd?: string
    firstMessage?: string
  }) => Promise<{
    sessionId: string
    inheritedEventCount: number
    agentPreset: string
  }>
  /**
   * 复盘会话：新开会话 + 只读预设 + 注入会话过程数据。
   * 与 fork 路分开，因为只有新开会话才能让只读预设真正生效。
   */
  readonly createReviewSession: (request: {
    targetSessionId: string
    cwd: string
    agentPreset?: string
  }) => Promise<{
    sessionId: string
    agentPreset: string
    digestTurns: number
  }>
  readonly logger?: (message: string) => void
}

/** 构造路由处理器。 */
export function createRpcHandler(deps: SideAskRpcDeps) {
  const log = deps.logger ?? (() => {})

  /** 分发一个方法调用。 */
  async function dispatch(method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'createSideSession': {
        const parentSessionId = params.parentSessionId
        if (typeof parentSessionId !== 'string' || parentSessionId === '') {
          throw new SideAskRpcError('bad-request', 'parentSessionId 不能为空')
        }
        const atSeq =
          typeof params.atSeq === 'number' && Number.isFinite(params.atSeq)
            ? Math.floor(params.atSeq)
            : undefined
        const agentPreset =
          typeof params.agentPreset === 'string' && params.agentPreset !== ''
            ? params.agentPreset
            : undefined
        const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : undefined
        // 首条提问上限 32KB：一次追问或复盘提示词都远小于此，
        // 但这个上限能挡住把整个文件塞进来的误用。
        const firstMessage =
          typeof params.firstMessage === 'string' && params.firstMessage !== ''
            ? params.firstMessage.slice(0, 32 * 1024)
            : undefined
        return deps.createSideSession({ parentSessionId, atSeq, agentPreset, cwd, firstMessage })
      }
      case 'openReviewSession': {
        const targetSessionId = params.targetSessionId
        if (typeof targetSessionId !== 'string' || targetSessionId === '') {
          throw new SideAskRpcError('bad-request', 'targetSessionId 不能为空')
        }
        const cwd = params.cwd
        if (typeof cwd !== 'string' || cwd === '') {
          throw new SideAskRpcError('bad-request', '复盘会话需要 cwd')
        }
        const agentPreset =
          typeof params.agentPreset === 'string' && params.agentPreset !== ''
            ? params.agentPreset
            : undefined
        return deps.createReviewSession({ targetSessionId, cwd, agentPreset })
      }
      default:
        throw new SideAskRpcError('unknown-method', `未知方法 ${String(method)}`)
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackRequest(req)) {
      json(res, { ok: false, error: { code: 'forbidden', message: '仅接受本机回环请求' } }, 403)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      json(res, { ok: false, error: { code: 'bad-request', message: 'content-type 必须为 application/json' } }, 415)
      return
    }
    const body = await readJsonBody(req)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      json(res, { ok: false, error: { code: 'bad-request', message: '请求体不是合法 JSON 对象' } })
      return
    }
    const record = body as Record<string, unknown>
    const method = typeof record.method === 'string' ? record.method : ''
    const params =
      record.params === undefined || record.params === null
        ? {}
        : (record.params as Record<string, unknown>)
    if (typeof params !== 'object' || Array.isArray(params)) {
      json(res, { ok: false, error: { code: 'bad-request', message: 'params 必须是对象' } })
      return
    }
    // 会新建 agent 的方法必须显式确认，避免误触或有缺陷的调用方反复拉起会话。
    if (NEEDS_CONFIRM.has(method) && params.confirm !== true) {
      json(res, { ok: false, error: { code: 'not-confirmed', message: '该方法需要 confirm: true' } })
      return
    }
    try {
      const value = await dispatch(method, params)
      json(res, { ok: true, value })
    } catch (error) {
      const code = error instanceof SideAskRpcError ? error.code : 'internal'
      const message = String(error instanceof Error ? error.message : error)
      if (code === 'internal') log(`dsh-selection-ask: ${method} 失败: ${message}`)
      json(res, { ok: false, error: { code, message } })
    }
  }
}

/** 带稳定 code 的 RPC 错误。 */
export class SideAskRpcError extends Error {
  constructor(
    readonly code: 'bad-request' | 'not-confirmed' | 'unknown-method' | 'internal',
    message: string,
  ) {
    super(message)
    this.name = 'SideAskRpcError'
  }
}
