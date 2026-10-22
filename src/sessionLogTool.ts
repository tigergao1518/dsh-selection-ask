/**
 * 复盘用的模型可调工具。
 *
 * 复盘会话的输入分两段：
 *   1. 开局由插件注入**提炼后的过程数据**（sessionDigest）；
 *   2. 模型需要细节时，调用本模块注册的工具回查**原始事件**。
 *
 * 为什么要有第 2 段：提炼会丢细节（完整的报错文本、某一步到底调了什么、
 * 参数长什么样）。复盘的价值恰恰常在这些细节里。但把 7 MB 原始日志直接
 * 塞进上下文既不现实也没必要，所以做成按需查询。
 *
 * 工具只读日志，绝不写任何东西；查询结果有明确上限，避免一次拉爆上下文。
 *
 * @module dsh-selection-ask/sessionLogTool
 */

import type { Context } from '@deepseek-ai/cordis'

import { readSessionLog, SessionLogError, type SessionLogEvent } from './sessionLog.ts'
import { digestSession, renderDigest } from './sessionDigest.ts'
import { locateSessionLog } from './sessionLogLocate.ts'

/** 单次查询最多返回多少条事件。 */
const MAX_ROWS = 60

/** 单条事件渲染后的最大字符数（超出截断，避免一条巨型工具输出吃掉上下文）。 */
const MAX_CELL = 600

/** 工具名。 */
export const SESSION_LOG_TOOL = 'read_session_log'

/** 工具依赖。 */
export interface SessionLogToolDeps {
  /** `<DSH_HOME>/sessions`。 */
  readonly sessionsRoot: string
  /** 读文件（注入以便测试）。 */
  readonly readFile: (path: string) => Buffer
  /** 解压单帧（注入以便测试）。 */
  readonly decompress: (frame: Buffer) => Buffer
  /** 诊断日志。 */
  readonly log?: (message: string) => void
}

/** 把事件的 data 渲染成紧凑可读文本。 */
function renderData(data: unknown): string {
  if (data === undefined) return ''
  let text: string
  try {
    text = JSON.stringify(data)
  } catch {
    text = String(data)
  }
  if (text === undefined) return ''
  return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…(截断)` : text
}

/** 事件类型的同义词归并，让模型能用「报错」这类口语筛选。 */
function matchesTypeFilter(eventType: string, filter: string): boolean {
  if (filter === '' || filter === 'all') return true
  if (filter === eventType) return true
  switch (filter) {
    case 'error': // 失败的工具结果 + 模型重试
      return eventType === 'tool/result' || eventType.startsWith('llm/retry')
    case 'tool':
      return eventType === 'tool/call' || eventType === 'tool/result'
    case 'message':
      return eventType.endsWith('/message')
    default:
      return false
  }
}

/**
 * 注册 `read_session_log` 工具。
 *
 * @param ctx - host 上下文。
 * @param deps - 日志定位与读取依赖。
 * @returns 注册 disposer；注册失败（如缺 tools 服务）返回 undefined。
 */
export async function registerSessionLogTool(
  ctx: Context,
  deps: SessionLogToolDeps,
): Promise<(() => void) | undefined> {
  const tools = ctx.get('tools')
  if (tools === undefined) return undefined

  let defineTool: unknown
  try {
    // 与 dsh-plugin-rewind 同样的做法：懒加载，解析失败只损失这个工具。
    // 包名在编译期不可解析（不是本项目的依赖，只在宿主运行时存在），
    // 所以用变量间接导入，避免 tsc 把它当静态依赖去解析。
    const moduleName = '@deepseek-ai/dsh-tools'
    ;({ defineTool } = (await import(/* @vite-ignore */ moduleName)) as { defineTool: unknown })
  } catch (error) {
    deps.log?.(`read_session_log 工具不可用（无法加载 dsh-tools）：${String(error)}`)
    return undefined
  }
  if (typeof defineTool !== 'function') return undefined

  const load = (sessionId: string) => {
    const path = locateSessionLog(deps.sessionsRoot, sessionId)
    if (path === undefined) {
      throw new SessionLogError('not-found', `找不到会话 ${sessionId} 的日志文件`)
    }
    return readSessionLog(path, { readFile: deps.readFile, decompress: deps.decompress })
  }

  const definition = (defineTool as (def: unknown) => unknown)({
    name: SESSION_LOG_TOOL,
    description: [
      '回查一个 DSH 会话的原始事件日志，用于复盘时看细节。',
      'action=digest 返回该会话的过程数据概览（每轮 token/工具数/报错/耗时）。',
      'action=events 返回原始事件，可用 turn 限定轮次、type 筛选类型（tool / error / message 或精确事件名）、limit 限制条数。',
      '日志是只读的，本工具不会修改任何东西。',
      '典型用法：先看 digest 定位可疑轮次，再用 events 带上 turn 去看那一轮到底发生了什么。',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['digest', 'events'],
        description: 'digest 看概览，events 看原始事件',
      },
      session_id: {
        type: 'string',
        required: true,
        description: '要回查的会话 id（复盘会话可在开局摘要里看到它）',
      },
      turn: {
        type: 'integer',
        description: '只看第几轮（events 用）',
      },
      type: {
        type: 'string',
        description: '事件类型筛选：tool / error / message，或精确事件名如 tool/result',
      },
      limit: {
        type: 'integer',
        description: `最多返回多少条事件，默认 30，上限 ${MAX_ROWS}`,
      },
    },
    async execute(args: {
      action: string
      session_id: string
      turn?: number
      type?: string
      limit?: number
    }) {
      const sessionId = String(args.session_id ?? '').trim()
      if (sessionId === '') throw new Error('session_id 不能为空')

      const log = load(sessionId)

      if (args.action === 'digest') {
        const digest = digestSession(log.events)
        return {
          sessionId,
          turnCount: digest.turnCount,
          totalOutputTokens: digest.totalOutputTokens,
          finalContextTokens: digest.finalContextTokens,
          totalToolErrors: digest.totalToolErrors,
          text: renderDigest(digest),
          // 日志自检：帧数、跳过帧、坏行都报出来，避免「读到残缺日志却不知道」。
          logHealth: {
            frames: log.frames,
            skippedFrames: log.skippedFrames,
            badLines: log.badLines,
            events: log.events.length,
          },
        }
      }

      // action=events
      const limit = Math.min(Math.max(1, Number(args.limit ?? 30) || 30), MAX_ROWS)
      const typeFilter = typeof args.type === 'string' ? args.type : ''
      const turnFilter = args.turn === undefined ? undefined : Number(args.turn)

      // 先按类型筛，再按轮次筛，最后截断。
      // 轮次归属：事件本身不带 turn 的（如 user/message 由 turn/start 划定范围），
      // 所以先扫一遍建立 seq → turn 映射。
      const turnOfSeq = new Map<number, number>()
      let currentTurn: number | undefined
      for (const event of log.events) {
        if (event.type === 'turn/start') {
          currentTurn = Number((event.data as { turn?: unknown })?.turn ?? 0)
        }
        if (currentTurn !== undefined) turnOfSeq.set(event.seq, currentTurn)
        if (event.type === 'turn/end') currentTurn = undefined
      }

      const matched: SessionLogEvent[] = []
      for (const event of log.events) {
        if (!matchesTypeFilter(event.type, typeFilter)) continue
        if (turnFilter !== undefined && turnOfSeq.get(event.seq) !== turnFilter) continue
        matched.push(event)
      }

      const rows = matched.slice(0, limit).map((event) => ({
        seq: event.seq,
        turn: turnOfSeq.get(event.seq),
        type: event.type,
        data: renderData(event.data),
      }))

      return {
        sessionId,
        matched: matched.length,
        returned: rows.length,
        truncated: matched.length > rows.length,
        rows,
        logHealth: {
          frames: log.frames,
          skippedFrames: log.skippedFrames,
          badLines: log.badLines,
        },
      }
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          text?: string
          rows?: Array<{ seq: number; turn?: number; type: string; data: string }>
          matched?: number
          returned?: number
          truncated?: boolean
        }
        if (typeof v.text === 'string') return [{ type: 'text', text: v.text }]
        if (Array.isArray(v.rows)) {
          const head =
            v.truncated === true
              ? `匹配 ${v.matched} 条，返回前 ${v.returned} 条：`
              : `匹配 ${v.matched} 条：`
          const lines = v.rows.map(
            (r) => `[seq ${r.seq}${r.turn === undefined ? '' : ` 第${r.turn}轮`}] ${r.type}: ${r.data}`,
          )
          return [{ type: 'text', text: [head, ...lines].join('\n') }]
        }
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
  })

  return ctx.effect(
    () => (tools as { register: (def: unknown) => () => void }).register(definition),
    'dsh-selection-ask: read_session_log tool',
  ) as unknown as () => void
}
