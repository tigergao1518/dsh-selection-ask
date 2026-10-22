import type { ReactElement } from 'react';
/** 复盘入口按钮。 */
export declare function ReviewEntry({ sessionId, cwd, }: {
    sessionId: string;
    /** 当前会话的工作目录；复盘会话要有自己的 cwd，必须是绝对路径。 */
    cwd?: string;
}): ReactElement;
/**
 * 入口按钮样式。
 *
 * 只使用已发布的主题 token catalog（Theme.listTokens 列出的 14 个）：
 * bg-base / bg-layer-1 / bg-layer-2 / bg-overlay / border-l1 / border-l2 /
 * brand-primary / label-primary / label-secondary / state-* / sidebar-fill。
 *
 * 不要发明 `--dsw-alias-label-tertiary`、`--dsw-alias-interactive-bg-hover`、
 * `--dsw-radius-sm` 这类 catalog 外的名字——它们在出厂主题上解析不出值：
 * 前者让图标在浅色主题下变成几乎看不见的浅灰，正是 0.3.0 首版踩的坑。
 * 尺寸同理，一律写固定值。
 */
export declare const REVIEW_CSS = "\n.dsq-review-btn {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background: transparent;\n  /* label-secondary \u5728 catalog \u5185\uFF1Btertiary \u4E0D\u5728\uFF0C\u52FF\u7528\u3002 */\n  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));\n  cursor: pointer;\n}\n.dsq-review-btn svg {\n  width: 15px;\n  height: 15px;\n}\n.dsq-review-btn:hover {\n  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));\n  color: var(--dsw-alias-label-primary, #1f2329);\n}\n.dsq-review-btn:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);\n  outline-offset: 2px;\n}\n";
