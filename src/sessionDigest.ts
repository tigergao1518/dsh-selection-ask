/**
 * 会话过程数据提炼。
 *
 * 复盘不应该读完整原始日志（一个真实会话 7 MB、2500 条事件），
 * 而应该读**提炼后的过程数据**：每轮花了多少 token、调了多少工具、
 * 有没有报错、耗时多久、用户问的是什么。
 *
 * 这份提炼结果是复盘会话的「第一段输入」；模型需要细节时，
 * 再用 `read_session_log` 工具按轮次回查原始事件。
 *
 * @module dsh-selection-ask/sessionDigest
 */

import type { SessionLogEvent } from './sessionLog.ts'

/** 一轮的提炼结果。 */
export interface TurnDigest {
  readonly turn: number
  /** 用户这一轮的提问（截断），空串表示这是自动续跑的轮次。 */
  readonly prompt: string
  readonly startedAt?: number
  readonly durationMs?: number
  /** 模型步数。 */
  readonly steps: number
  /** 工具调用次数。 */
  readonly toolCalls: number
  /** 失败的工具调用次数。 */
  readonly toolErrors: number
  /**
   * 本轮模型实际产出的 token（累加各步的 outputTokens）。
   *
   * 不要用 `usage.totalTokens` 累加：那个字段**每一步都包含完整上下文**
   * （实测第 5 步就已经是 7870），累加只会得到一个随步数膨胀的假数字。
   * 复盘的「这轮花了多少」应当看模型真正产出的量。
   */
  readonly outputTokens: number
  /**
   * 本轮结束时的上下文规模（该轮最后一个 usage.totalTokens）。
   *
   * 这是判断「上下文膨胀」的正确口径：它反映轮到末尾时喂给模型多少，
   * 与 1M 窗口对比就知道离压缩还有多远。
   */
  readonly contextTokens: number
  /** 本轮从缓存读到的 token 合计（诊断缓存命中用，不计入消耗）。 */
  readonly cacheReadTokens: number
  /** 结束原因（turn/end 的 reason）。 */
  readonly endReason?: string
  /** 本轮发生过的模型重试次数。 */
  readonly retries: number
  /** 失败工具调用的简要描述，最多留 5 条。 */
  readonly errorSamples: readonly string[]
}

/** 整个会话的提炼结果。 */
export interface SessionDigest {
  readonly turnCount: number
  /** 全会话模型产出的 token 合计（各轮 outputTokens 之和）。 */
  readonly totalOutputTokens: number
  /** 会话结束时的上下文规模（最后一轮末的 totalTokens）。 */
  readonly finalContextTokens: number
  readonly totalToolCalls: number
  readonly totalToolErrors: number
  readonly totalRetries: number
  /** 发生过压缩的次数（compaction 事件）。 */
  readonly compactions: number
  /** 发生过对话回退的次数（rewind 标记）。 */
  readonly rewinds: number
  /** 总时长（第一轮开始到最后事件）。 */
  readonly spanMs?: number
  readonly turns: readonly TurnDigest[]
  /** 上下文组成：这个会话的窗口到底被什么占满了。 */
  readonly composition?: ContextComposition
}

/** 上下文组成：各类内容各占多少字符。 */
export interface ContextComposition {
  /** 系统提示（取最后一条，它是当前生效的那份）。 */
  readonly systemPromptChars: number
  /** 工具 schema（取最后一次 request/header 里的 tools，反映当前工具集）。 */
  readonly toolSchemaChars: number
  /** 工具 schema 覆盖的工具个数。 */
  readonly toolCount: number
  /** 用户消息累计字符。 */
  readonly userMessageChars: number
  /** 助手回复累计字符。 */
  readonly assistantMessageChars: number
  /** 工具结果累计字符——长会话里通常是最大头。 */
  readonly toolResultChars: number
  /** 插件/系统注入内容累计字符（steering、inbox 注入等）。 */
  readonly injectedChars: number
  /** 上述各项之和，用于算占比。 */
  readonly totalChars: number
  /** 模型上下文窗口（取自 request/context 的 contextWindow）。 */
  readonly contextWindow?: number
}

/** 从事件里取一段可读文本（用于 summary）。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
  }
  return parts.join('')
}

/**
 * 判断一条 user/message 是不是「人真正打的字」。
 *
 * 光看 `source.kind === 'user'` 不够：DSH 把 system-reminder（工作区指令、
 * 插件提示、团队消息）也归在 user 消息流里，实测首轮的「提问」会被这些
 * 内容顶掉，渲染出一个以 `<system-reminder>` 开头的假提问。
 * 所以再加一道内容侧的判据：以 `<` 开头的注入块不算人类提问。
 */
function isHumanPrompt(event: SessionLogEvent): boolean {
  const source = (event.data as { source?: { kind?: unknown; plugin?: unknown } } | undefined)?.source
  if (source?.kind !== 'user') return false
  // source.plugin 存在说明是某个插件注入的，不是人打的。
  if (typeof source.plugin === 'string' && source.plugin !== '') return false
  const text = textOf((event.data as { content?: unknown })?.content).trimStart()
  if (text === '') return false
  // 注入块（system-reminder / 工作区指令等）以尖括号开头。
  if (text.startsWith('<')) return false
  return true
}

/** 提炼一条失败工具调用的简述。 */
function describeToolError(event: SessionLogEvent): string {
  const data = event.data as
    | { name?: unknown; error?: { name?: unknown; code?: unknown; reason?: unknown } }
    | undefined
  const name = typeof data?.name === 'string' ? data.name : '工具'
  const err = data?.error
  if (err === undefined) return `${name} 失败`
  const code = typeof err.code === 'string' ? err.code : ''
  const reason = typeof err.reason === 'string' ? err.reason : ''
  const detail = [code, reason].filter((s) => s !== '').join(' / ')
  return detail === '' ? `${name} 失败` : `${name}: ${detail}`
}

/** 安全地取一个值的 JSON 字符数（循环引用或超大类值不炸）。 */
function safeJsonLength(value: unknown): number {
  if (value === undefined || value === null) return 0
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * 把事件流提炼成会话过程数据。
 *
 * @param events - 按 seq 升序的事件。
 * @param options - `promptLimit` 控制每轮提问保留多少字符（默认 120）。
 */
export function digestSession(
  events: readonly SessionLogEvent[],
  options: { promptLimit?: number } = {},
): SessionDigest {
  const promptLimit = options.promptLimit ?? 120

  const turns: TurnDigest[] = []
  let current:
    | {
        turn: number
        prompt: string
        startedAt?: number
        steps: number
        toolCalls: number
        toolErrors: number
        outputTokens: number
        contextTokens: number
        cacheReadTokens: number
        retries: number
        errorSamples: string[]
      }
    | undefined

  let compactions = 0
  let rewinds = 0
  let firstTime: number | undefined
  let lastTime: number | undefined

  // ── 上下文组成的累计器 ────────────────────────────────────────────────
  // 这些是「这个会话的窗口被什么占满了」的实测数据。长会话里工具结果
  // 往往是最大头（实测一个会话 1.26 MB，是工具 schema 的 8 倍），
  // 而轮次级 token 总数完全看不出这一点——所以必须单独统计。
  let userMessageChars = 0
  let assistantMessageChars = 0
  let toolResultChars = 0
  let injectedChars = 0
  /** 系统提示取「最后一条」：它是当前生效的那份（会被替换）。 */
  let systemPromptChars = 0
  /** 工具 schema 取「最后一次 request/header」：反映当前工具集。 */
  let toolSchemaChars = 0
  let toolCount = 0
  let contextWindow: number | undefined

  for (const event of events) {
    if (typeof event.time === 'number') {
      if (firstTime === undefined) firstTime = event.time
      lastTime = event.time
    }

    switch (event.type) {
      case 'turn/start': {
        const turn = Number((event.data as { turn?: unknown })?.turn ?? 0)
        current = {
          turn,
          prompt: '',
          startedAt: event.time,
          steps: 0,
          toolCalls: 0,
          toolErrors: 0,
          outputTokens: 0,
          contextTokens: 0,
          cacheReadTokens: 0,
          retries: 0,
          errorSamples: [],
        }
        break
      }
      case 'step/start': {
        if (current !== undefined) current.steps += 1
        break
      }
      case 'tool/call': {
        if (current !== undefined) current.toolCalls += 1
        break
      }
      case 'tool/result': {
        // 组成：工具结果字符量——长会话里通常是最大头。
        toolResultChars += safeJsonLength(event.data)
        if (current !== undefined) {
          const hasError = (event.data as { error?: unknown })?.error !== undefined
          if (hasError) {
            current.toolErrors += 1
            if (current.errorSamples.length < 5) {
              current.errorSamples.push(describeToolError(event))
            }
          }
        }
        break
      }
      case 'llm/retry': {
        if (current !== undefined) current.retries += 1
        break
      }
      case 'assistant/message': {
        // 组成：助手回复字符量。
        assistantMessageChars += textOf(
          (event.data as { message?: { content?: unknown } })?.message?.content,
        ).length
        if (current !== undefined) {
          const usage = (event.data as {
            usage?: {
              inputTokens?: unknown
              outputTokens?: unknown
              cacheReadTokens?: unknown
              totalTokens?: unknown
            }
          })?.usage
          const output = Number(usage?.outputTokens ?? 0)
          if (Number.isFinite(output) && output > 0) current.outputTokens += output
          const cacheRead = Number(usage?.cacheReadTokens ?? 0)
          if (Number.isFinite(cacheRead) && cacheRead > 0) current.cacheReadTokens += cacheRead
          // 上下文规模取「最新一次」，不是累加：totalTokens 每步都含完整上下文。
          const total = Number(usage?.totalTokens ?? 0)
          if (Number.isFinite(total) && total > 0) current.contextTokens = total
        }
        break
      }
      case 'user/message': {
        const content = (event.data as { content?: unknown })?.content
        // 组成：用户消息字符量。
        userMessageChars += textOf(content).length
        if (current !== undefined && current.prompt === '' && isHumanPrompt(event)) {
          const text = textOf(content).replace(/\s+/g, ' ').trim()
          current.prompt = text.length > promptLimit ? `${text.slice(0, promptLimit)}…` : text
        }
        break
      }
      case 'turn/end': {
        if (current !== undefined && Number((event.data as { turn?: unknown })?.turn ?? -1) === current.turn) {
          const reason = (event.data as { reason?: unknown })?.reason
          turns.push({
            turn: current.turn,
            prompt: current.prompt,
            startedAt: current.startedAt,
            durationMs:
              current.startedAt !== undefined && event.time !== undefined
                ? Math.max(0, event.time - current.startedAt)
                : undefined,
            steps: current.steps,
            toolCalls: current.toolCalls,
            toolErrors: current.toolErrors,
            outputTokens: current.outputTokens,
            contextTokens: current.contextTokens,
            cacheReadTokens: current.cacheReadTokens,
            endReason: typeof reason === 'string' ? reason : undefined,
            retries: current.retries,
            errorSamples: current.errorSamples,
          })
          current = undefined
        }
        break
      }
      case 'compaction/start':
      case 'compaction/summary': {
        // 只数 start，summary 是同一次压缩的收尾，重复计会翻倍。
        if (event.type === 'compaction/start') compactions += 1
        break
      }
      case 'system/message':
      case 'developer/message': {
        // 组成：系统提示取「最后一条」——它是当前生效的那份（会被替换）。
        if (event.type === 'system/message') {
          systemPromptChars = textOf(
            (event.data as { message?: { content?: unknown } })?.message?.content,
          ).length
        }
        // 回退标记：本插件与 dsh-plugin-rewind 都用 id 前缀区分自己的标记。
        const id = (event.data as { message?: { id?: unknown } })?.message?.id
        if (typeof id === 'string' && id.startsWith('rewind-')) rewinds += 1
        break
      }
      case 'request/header': {
        // 组成：工具 schema 取「最后一次」——反映当前工具集。
        const tools = (event.data as { header?: { tools?: unknown } })?.header?.tools
        if (Array.isArray(tools)) {
          toolCount = tools.length
          toolSchemaChars = safeJsonLength(tools)
        }
        break
      }
      case 'request/context': {
        // 组成：模型上下文窗口，用来判断「离上限还有多远」。
        const cw = (event.data as { contextWindow?: unknown })?.contextWindow
        if (typeof cw === 'number' && cw > 0) contextWindow = cw
        break
      }
      case 'agent/inbox/spliced':
      case 'steering': {
        // 组成：插件/系统注入内容。
        injectedChars += safeJsonLength(event.data)
        break
      }
      default:
        break
    }
  }

  // 没有 turn/end 的最后一轮（会话正在跑）也要收进来，否则复盘漏掉最新进展。
  if (current !== undefined) {
    turns.push({
      turn: current.turn,
      prompt: current.prompt,
      startedAt: current.startedAt,
      durationMs: undefined,
      steps: current.steps,
      toolCalls: current.toolCalls,
      toolErrors: current.toolErrors,
      outputTokens: current.outputTokens,
      contextTokens: current.contextTokens,
      cacheReadTokens: current.cacheReadTokens,
      endReason: undefined,
      retries: current.retries,
      errorSamples: current.errorSamples,
    })
  }

  const composition: ContextComposition = {
    systemPromptChars,
    toolSchemaChars,
    toolCount,
    userMessageChars,
    assistantMessageChars,
    toolResultChars,
    injectedChars,
    totalChars:
      systemPromptChars + toolSchemaChars + userMessageChars +
      assistantMessageChars + toolResultChars + injectedChars,
    contextWindow,
  }

  return {
    turnCount: turns.length,
    totalOutputTokens: turns.reduce((sum, t) => sum + t.outputTokens, 0),
    // 会话末的上下文规模：取最后一个有值的轮次，而不是把各轮相加。
    finalContextTokens: [...turns].reverse().find((t) => t.contextTokens > 0)?.contextTokens ?? 0,
    totalToolCalls: turns.reduce((sum, t) => sum + t.toolCalls, 0),
    totalToolErrors: turns.reduce((sum, t) => sum + t.toolErrors, 0),
    totalRetries: turns.reduce((sum, t) => sum + t.retries, 0),
    compactions,
    rewinds,
    spanMs:
      firstTime !== undefined && lastTime !== undefined ? Math.max(0, lastTime - firstTime) : undefined,
    turns,
    composition,
  }
}

/** 把提炼结果渲染成给模型读的紧凑文本。 */
export function renderDigest(digest: SessionDigest): string {
  const lines: string[] = []
  const secs = (ms?: number) => (ms === undefined ? '?' : `${(ms / 1000).toFixed(1)}s`)
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

  lines.push(
    `共 ${digest.turnCount} 轮 · 模型产出 ${k(digest.totalOutputTokens)} tok · ` +
      `末尾上下文 ${k(digest.finalContextTokens)} tok · ` +
      `${digest.totalToolCalls} 次工具调用（${digest.totalToolErrors} 次失败）· ` +
      `${digest.totalRetries} 次模型重试 · 压缩 ${digest.compactions} 次 · ` +
      `回退 ${digest.rewinds} 次 · 总跨度 ${secs(digest.spanMs)}`,
  )
  lines.push(
    '（口径：产出 = 模型实际生成的 token 之和；末尾上下文 = 最后一轮喂给模型的规模，' +
      '与窗口上限对比可判断离压缩还有多远。）',
  )

  // ── 上下文组成 ────────────────────────────────────────────────────────
  // 轮次级 token 总数只能告诉你「多」，说不出「什么在占地方」。
  // 组成按占比降序列出来，最大头一眼可见——长会话里通常是工具结果
  // （实测一个会话占 1.26 MB，是工具 schema 的 8 倍），
  // 那该给的建议就是「少用会吐大段输出的工具」，而不是「token 超标」。
  const c = digest.composition
  if (c !== undefined && c.totalChars > 0) {
    const pct = (n: number) => `${((n / c.totalChars) * 100).toFixed(1)}%`
    const rows: Array<{ label: string; chars: number }> = [
      { label: '工具结果', chars: c.toolResultChars },
      { label: '工具 schema', chars: c.toolSchemaChars },
      { label: '系统提示', chars: c.systemPromptChars },
      { label: '用户消息', chars: c.userMessageChars },
      { label: '助手回复', chars: c.assistantMessageChars },
      { label: '注入内容', chars: c.injectedChars },
    ]
      .filter((row) => row.chars > 0)
      .sort((a, b) => b.chars - a.chars)

    lines.push('')
    lines.push(
      `上下文组成（合计 ${k(c.totalChars)} 字符` +
        `${c.contextWindow === undefined ? '' : `，窗口 ${k(c.contextWindow)} tok`}）：`,
    )
    for (const row of rows) {
      const extra =
        row.label === '工具 schema' && c.toolCount > 0 ? `（${c.toolCount} 个工具）` : ''
      lines.push(`  ${row.label}${extra}：${k(row.chars)} 字符，占 ${pct(row.chars)}`)
    }
    // 明确指出最大头，让模型不用自己比重。
    const top = rows[0]
    if (top !== undefined) {
      lines.push(`  → 最大头是「${top.label}」，要控制上下文先看它。`)
    }
  }

  lines.push('')
  for (const t of digest.turns) {
    const flags: string[] = []
    if (t.toolErrors > 0) flags.push(`⚠${t.toolErrors} 错`)
    if (t.retries > 0) flags.push(`↻${t.retries} 重试`)
    if (t.endReason !== undefined && t.endReason !== 'completed') flags.push(`end=${t.endReason}`)
    const tail = flags.length > 0 ? `  ${flags.join(' ')}` : ''
    lines.push(
      `第 ${t.turn} 轮 | ${t.steps} 步 ${t.toolCalls} 工具 | 产出 ${k(t.outputTokens)} tok ` +
        `上下文 ${k(t.contextTokens)} | ${secs(t.durationMs)}${tail} | ` +
        `${t.prompt === '' ? '(自动续跑)' : t.prompt}`,
    )
    for (const sample of t.errorSamples) lines.push(`    · ${sample}`)
  }
  return lines.join('\n')
}
