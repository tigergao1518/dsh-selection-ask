/**
 * 会话日志读取器。
 *
 * DSH 把一个会话的全部事件写在
 *   `~/.dsh/sessions/<项目路径编码>/<会话id>/session.v4.jsonl.zstd`
 * 里，每行一个 JSON 事件。
 *
 * **关键陷阱：这个文件是「多帧 zstd」追加流，不是单帧。**
 * 实测一个 2.6 MB 的日志含 1433 个帧；而 Node 的 `zstdDecompressSync` 与
 * `createZstdDecompress()` **都只解第一帧**，得到 223 字节就结束，
 * 而且**不报错**。若照单次解压实现，复盘只会看到日志开头的 0.003%，
 * 却会给出看似合理的错误结论——这是本项目踩过的坑，故在此逐帧处理。
 *
 * 本模块只读、零依赖（zstd 来自 Node 内置 zlib）。
 *
 * @module dsh-selection-ask/sessionLog
 */
/** 一条会话事件（只声明本模块用到的字段）。 */
export interface SessionLogEvent {
    readonly seq: number;
    readonly type: string;
    readonly time?: number;
    readonly data?: Record<string, unknown>;
    readonly surfaceOp?: unknown;
}
/** 读出的一段日志。 */
export interface SessionLog {
    /** 事件文件路径，便于报错时定位。 */
    readonly path: string;
    /** 压缩文件字节数。 */
    readonly compressedBytes: number;
    /** 解压后字节数。 */
    readonly rawBytes: number;
    /** zstd 帧数（诊断用：帧数 = 1 而事件数很少，说明日志还没写多少）。 */
    readonly frames: number;
    /** 解压失败被跳过的帧数。>0 说明日志可能损坏。 */
    readonly skippedFrames: number;
    /** 按 seq 升序的事件。 */
    readonly events: readonly SessionLogEvent[];
    /** 解析失败的行数。>0 说明日志可能损坏。 */
    readonly badLines: number;
}
/** 读取失败时抛出，带稳定 code 便于上层给用户看。 */
export declare class SessionLogError extends Error {
    readonly code: 'not-found' | 'unreadable' | 'decompress-failed' | 'empty' | 'no-route';
    constructor(code: 'not-found' | 'unreadable' | 'decompress-failed' | 'empty' | 'no-route', message: string);
}
/**
 * 逐帧解压一个多帧 zstd 缓冲。
 *
 * 一帧解不开不影响其它帧——日志是追加写的，尾部半截帧是正常现象
 * （写的时候进程被杀），所以跳过的帧要计数上报，而不是整体失败。
 *
 * 注意 Node 的行为：对「魔数正确但内容损坏」的帧，`zstdDecompressSync`
 * **不一定抛错**，实测会安静地返回 0 字节。若只捕获异常，这种帧会被
 * 当成「解出了空内容」混进结果里，调用方完全察觉不到数据缺失。
 * 所以「抛错」与「解出空」都计为跳过。
 */
export declare function decompressFrames(buf: Buffer, decompress: (frame: Buffer) => Buffer): {
    parts: Buffer[];
    frames: number;
    skipped: number;
};
/** 把解压出的若干段拼成文本并解析成事件数组。 */
export declare function parseEvents(text: string): {
    events: SessionLogEvent[];
    badLines: number;
};
/** 读取器依赖注入：便于单测替换解压实现与文件读取。 */
export interface SessionLogDeps {
    readonly readFile: (path: string) => Buffer;
    readonly decompress: (frame: Buffer) => Buffer;
}
/**
 * 读取并解析一个会话日志文件。
 *
 * @param path - `session.v4.jsonl.zstd` 的完整路径。
 * @param deps - 文件读取与单帧解压实现。
 * @throws SessionLogError，code 说明原因。
 */
export declare function readSessionLog(path: string, deps: SessionLogDeps): SessionLog;
