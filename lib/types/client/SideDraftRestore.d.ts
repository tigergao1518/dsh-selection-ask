import type { ReactElement } from 'react';
/**
 * 旁路会话的草稿回填器。
 *
 * 「开侧栏追问」的预期是**把文本带进侧栏会话的输入框、但不发送**。
 * 点击时文本暂存在 `pendingDrafts`（按 childSessionId 索引），
 * 这个条目在子会话的 composer 挂载时把它取出来写进输入框。
 *
 * 挂在 `conversation.input.left`（session-scoped，输入框工具行左侧）：
 * 该条目无可见界面，纯粹是个执行时机——子会话一渲染就会挂载。
 * 机制与 dsh-turn-actions 的回填器相同，那条路已实测可用。
 */
export declare function SideDraftRestore({ sessionId, inputActions, }: {
    sessionId?: string;
    inputActions?: {
        setDraft: (text: string) => void;
    };
}): ReactElement | null;
