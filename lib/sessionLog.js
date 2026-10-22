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
/** zstd 帧魔数：28 B5 2F FD。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** 读取失败时抛出，带稳定 code 便于上层给用户看。 */
export class SessionLogError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SessionLogError';
    }
}
/**
 * 找出所有 zstd 帧的起点。
 *
 * 靠魔数扫描而不是靠解压器报错定位：解压器读完第一帧就正常结束，
 * 不会告诉我们后面还有内容。
 */
function findFrameStarts(buf) {
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
        if (buf[i] === ZSTD_MAGIC[0] &&
            buf[i + 1] === ZSTD_MAGIC[1] &&
            buf[i + 2] === ZSTD_MAGIC[2] &&
            buf[i + 3] === ZSTD_MAGIC[3]) {
            starts.push(i);
        }
    }
    return starts;
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
export function decompressFrames(buf, decompress) {
    const starts = findFrameStarts(buf);
    if (starts.length === 0) {
        // 一个魔数都没有：可能是单帧无魔数（不合法）或空文件。
        // 交给调用方按 empty 处理。
        return { parts: [], frames: 0, skipped: 0 };
    }
    const parts = [];
    let skipped = 0;
    for (let i = 0; i < starts.length; i++) {
        const from = starts[i];
        const to = i + 1 < starts.length ? starts[i + 1] : buf.length;
        let out;
        try {
            out = decompress(buf.subarray(from, to));
        }
        catch {
            out = undefined;
        }
        if (out === undefined || out.length === 0) {
            skipped += 1;
            continue;
        }
        parts.push(out);
    }
    return { parts, frames: starts.length, skipped };
}
/** 把解压出的若干段拼成文本并解析成事件数组。 */
export function parseEvents(text) {
    const events = [];
    let badLines = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        try {
            const value = JSON.parse(line);
            if (value !== null && typeof value === 'object' && typeof value.type === 'string') {
                events.push(value);
            }
            else {
                badLines += 1;
            }
        }
        catch {
            badLines += 1;
        }
    }
    // 事件按 seq 排序：多帧拼接后顺序本该正确，但显式排序让下游逻辑不必假设。
    events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { events, badLines };
}
/**
 * 读取并解析一个会话日志文件。
 *
 * @param path - `session.v4.jsonl.zstd` 的完整路径。
 * @param deps - 文件读取与单帧解压实现。
 * @throws SessionLogError，code 说明原因。
 */
export function readSessionLog(path, deps) {
    let buf;
    try {
        buf = deps.readFile(path);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ENOENT|no such file/i.test(message)) {
            throw new SessionLogError('not-found', `会话日志不存在：${path}`);
        }
        throw new SessionLogError('unreadable', `会话日志读不出来：${message}`);
    }
    if (buf.length === 0) {
        throw new SessionLogError('empty', `会话日志是空文件：${path}`);
    }
    const { parts, frames, skipped } = decompressFrames(buf, deps.decompress);
    if (parts.length === 0) {
        throw new SessionLogError(skipped > 0 ? 'decompress-failed' : 'empty', skipped > 0
            ? `会话日志的 ${skipped} 个 zstd 帧全部解压失败：${path}`
            : `会话日志里没有可解压的内容：${path}`);
    }
    const text = Buffer.concat(parts).toString('utf8');
    const { events, badLines } = parseEvents(text);
    if (events.length === 0) {
        throw new SessionLogError('empty', `会话日志解压后没有可解析的事件：${path}`);
    }
    return {
        path,
        compressedBytes: buf.length,
        rawBytes: text.length,
        frames,
        skippedFrames: skipped,
        events,
        badLines,
    };
}
