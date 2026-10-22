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
import type { Context } from '@deepseek-ai/cordis';
/** 工具名。 */
export declare const SESSION_LOG_TOOL = "read_session_log";
/** 工具依赖。 */
export interface SessionLogToolDeps {
    /** `<DSH_HOME>/sessions`。 */
    readonly sessionsRoot: string;
    /** 读文件（注入以便测试）。 */
    readonly readFile: (path: string) => Buffer;
    /** 解压单帧（注入以便测试）。 */
    readonly decompress: (frame: Buffer) => Buffer;
    /** 诊断日志。 */
    readonly log?: (message: string) => void;
}
/**
 * 注册 `read_session_log` 工具。
 *
 * @param ctx - host 上下文。
 * @param deps - 日志定位与读取依赖。
 * @returns 注册 disposer；注册失败（如缺 tools 服务）返回 undefined。
 */
export declare function registerSessionLogTool(ctx: Context, deps: SessionLogToolDeps): Promise<(() => void) | undefined>;
