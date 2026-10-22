/**
 * 会话日志定位。
 *
 * 日志在 `~/.dsh/sessions/<项目目录编码>/<会话id>/session.v4.jsonl.zstd`。
 *
 * 那个「项目目录编码」规则（`:`/`\` → `-`、非 ASCII → `~XXXX~` 的 UTF-16
 * 码元表达、整体用 `--` 包裹）**不在这里复刻**：它是 DSH 内部约定，
 * 换个版本就可能变，自己算一遍等于把版本耦合写死进插件。
 *
 * 改为**按目录名扫描**：先在 `<sessionId>` 这一层做全目录搜索（会话 id
 * 是全局唯一的），命中后就是那个会话目录。这样与编码规则完全解耦。
 *
 * @module dsh-selection-ask/sessionLogLocate
 */
/** 日志文件名。 */
export declare const SESSION_LOG_FILENAME = "session.v4.jsonl.zstd";
/**
 * 在 DSH 的 sessions 根目录下定位一个会话的日志文件。
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions`。
 * @param sessionId - 目标会话 id。
 * @returns 日志文件路径；找不到返回 undefined。
 */
export declare function locateSessionLog(sessionsRoot: string, sessionId: string): string | undefined;
/** 列出 sessions 根目录下所有会话 id（诊断与兜底用）。 */
export declare function listKnownSessions(sessionsRoot: string): string[];
