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
import type { SessionLogEvent } from './sessionLog.ts';
/** 一轮的提炼结果。 */
export interface TurnDigest {
    readonly turn: number;
    /** 用户这一轮的提问（截断），空串表示这是自动续跑的轮次。 */
    readonly prompt: string;
    readonly startedAt?: number;
    readonly durationMs?: number;
    /** 模型步数。 */
    readonly steps: number;
    /** 工具调用次数。 */
    readonly toolCalls: number;
    /** 失败的工具调用次数。 */
    readonly toolErrors: number;
    /**
     * 本轮模型实际产出的 token（累加各步的 outputTokens）。
     *
     * 不要用 `usage.totalTokens` 累加：那个字段**每一步都包含完整上下文**
     * （实测第 5 步就已经是 7870），累加只会得到一个随步数膨胀的假数字。
     * 复盘的「这轮花了多少」应当看模型真正产出的量。
     */
    readonly outputTokens: number;
    /**
     * 本轮结束时的上下文规模（该轮最后一个 usage.totalTokens）。
     *
     * 这是判断「上下文膨胀」的正确口径：它反映轮到末尾时喂给模型多少，
     * 与 1M 窗口对比就知道离压缩还有多远。
     */
    readonly contextTokens: number;
    /** 本轮从缓存读到的 token 合计（诊断缓存命中用，不计入消耗）。 */
    readonly cacheReadTokens: number;
    /** 结束原因（turn/end 的 reason）。 */
    readonly endReason?: string;
    /** 本轮发生过的模型重试次数。 */
    readonly retries: number;
    /** 失败工具调用的简要描述，最多留 5 条。 */
    readonly errorSamples: readonly string[];
}
/** 整个会话的提炼结果。 */
export interface SessionDigest {
    readonly turnCount: number;
    /** 全会话模型产出的 token 合计（各轮 outputTokens 之和）。 */
    readonly totalOutputTokens: number;
    /** 会话结束时的上下文规模（最后一轮末的 totalTokens）。 */
    readonly finalContextTokens: number;
    readonly totalToolCalls: number;
    readonly totalToolErrors: number;
    readonly totalRetries: number;
    /** 发生过压缩的次数（compaction 事件）。 */
    readonly compactions: number;
    /** 发生过对话回退的次数（rewind 标记）。 */
    readonly rewinds: number;
    /** 总时长（第一轮开始到最后事件）。 */
    readonly spanMs?: number;
    readonly turns: readonly TurnDigest[];
    /** 上下文组成：这个会话的窗口到底被什么占满了。 */
    readonly composition?: ContextComposition;
}
/** 上下文组成：各类内容各占多少字符。 */
export interface ContextComposition {
    /** 系统提示（取最后一条，它是当前生效的那份）。 */
    readonly systemPromptChars: number;
    /** 工具 schema（取最后一次 request/header 里的 tools，反映当前工具集）。 */
    readonly toolSchemaChars: number;
    /** 工具 schema 覆盖的工具个数。 */
    readonly toolCount: number;
    /** 用户消息累计字符。 */
    readonly userMessageChars: number;
    /** 助手回复累计字符。 */
    readonly assistantMessageChars: number;
    /** 工具结果累计字符——长会话里通常是最大头。 */
    readonly toolResultChars: number;
    /** 插件/系统注入内容累计字符（steering、inbox 注入等）。 */
    readonly injectedChars: number;
    /** 上述各项之和，用于算占比。 */
    readonly totalChars: number;
    /** 模型上下文窗口（取自 request/context 的 contextWindow）。 */
    readonly contextWindow?: number;
}
/**
 * 把事件流提炼成会话过程数据。
 *
 * @param events - 按 seq 升序的事件。
 * @param options - `promptLimit` 控制每轮提问保留多少字符（默认 120）。
 */
export declare function digestSession(events: readonly SessionLogEvent[], options?: {
    promptLimit?: number;
}): SessionDigest;
/** 把提炼结果渲染成给模型读的紧凑文本。 */
export declare function renderDigest(digest: SessionDigest): string;
