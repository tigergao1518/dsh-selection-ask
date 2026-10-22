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
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** 日志文件名。 */
export const SESSION_LOG_FILENAME = 'session.v4.jsonl.zstd';
/**
 * 在 DSH 的 sessions 根目录下定位一个会话的日志文件。
 *
 * @param sessionsRoot - `<DSH_HOME>/sessions`。
 * @param sessionId - 目标会话 id。
 * @returns 日志文件路径；找不到返回 undefined。
 */
export function locateSessionLog(sessionsRoot, sessionId) {
    if (!existsSync(sessionsRoot))
        return undefined;
    let projects;
    try {
        projects = readdirSync(sessionsRoot);
    }
    catch {
        return undefined;
    }
    for (const project of projects) {
        const sessionDir = join(sessionsRoot, project, sessionId);
        try {
            if (!statSync(sessionDir).isDirectory())
                continue;
        }
        catch {
            // 这个项目下没有该会话，继续
            continue;
        }
        const logPath = join(sessionDir, SESSION_LOG_FILENAME);
        if (existsSync(logPath))
            return logPath;
        // 会话目录存在但日志名不同（DSH 版本差异）：取目录里第一个 .zstd。
        try {
            const entry = readdirSync(sessionDir).find((name) => name.endsWith('.zstd'));
            if (entry !== undefined)
                return join(sessionDir, entry);
        }
        catch {
            /* 落到下面返回 undefined */
        }
    }
    return undefined;
}
/** 列出 sessions 根目录下所有会话 id（诊断与兜底用）。 */
export function listKnownSessions(sessionsRoot) {
    if (!existsSync(sessionsRoot))
        return [];
    const ids = [];
    try {
        for (const project of readdirSync(sessionsRoot)) {
            const projectDir = join(sessionsRoot, project);
            try {
                if (!statSync(projectDir).isDirectory())
                    continue;
                for (const session of readdirSync(projectDir)) {
                    try {
                        if (statSync(join(projectDir, session)).isDirectory())
                            ids.push(session);
                    }
                    catch {
                        /* 忽略 */
                    }
                }
            }
            catch {
                /* 忽略 */
            }
        }
    }
    catch {
        return [];
    }
    return ids;
}
