/**
 * 复盘会话的组装。
 *
 * 「复盘」与「选中追问」是两条不同的路径，差别在**要不要继承父会话的对话**：
 *
 * | | 选中追问 | 会话复盘 |
 * |---|---|---|
 * | 会话 | fork 父会话 | **新开会话** |
 * | 上下文 | 完整继承对话 | 不继承；改为读**日志文件**提炼过程数据 |
 * | 预设 | 继承父会话 | **指定只读预设，真正生效** |
 * | 数据 | 实时 | 从磁盘日志读，可重复读、可追溯 |
 *
 * 为什么复盘不 fork：fork 出的子会话已经「开始过」，官方
 * `agent-preset/locked` 拒绝再切预设，只读约束落不了地。新开会话的 id 不在
 * store 里，`meta.agentPreset` 能一步把只读工具集定死。
 *
 * 为什么复盘不继承对话：复盘需要的是**过程事实**（每轮花了多少、哪里报错、
 * 哪轮跑偏），不是把几万 token 的原对话再喂一遍。日志文件里有更准确、更省
 * 的答案；需要细节时模型还能用 `read_session_log` 回查原始事件。
 *
 * @module dsh-selection-ask/reviewSession
 */
import type { Context } from '@deepseek-ai/cordis';
/** 复盘会话默认用的只读预设 id，与 profile 里 preset-session-review 一致。 */
export declare const REVIEW_PRESET_ID = "session-review";
/** 复盘会话的组装依赖。 */
export interface ReviewSessionDeps {
    readonly sessionsRoot: string;
    readonly readFile: (path: string) => Buffer;
    readonly decompress: (frame: Buffer) => Buffer;
    readonly log?: (message: string) => void;
}
/** 组装复盘会话的创建函数。 */
export declare function mountReviewSessionFactory(ctx: Context, deps: ReviewSessionDeps): (request: {
    targetSessionId: string;
    cwd: string;
    agentPreset?: string;
}) => Promise<{
    sessionId: string;
    agentPreset: string;
    digestTurns: number;
}>;
