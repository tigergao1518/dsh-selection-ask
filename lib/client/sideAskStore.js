/**
 * 旁路会话客户端的 fiber 内单例。
 *
 * 单独放一个模块（而不是挂在 index.tsx 上）是为了避免循环引用：
 * 入口要注册用到它的组件，而那些组件又要 import 它。
 * 入口在 apply() 里 setSlot，其余模块只读。
 */
let client;
/** 由 client 入口在 apply() 里调用一次。 */
export function setSideAskClient(next) {
    client = next;
}
/** 取旁路会话客户端；未就绪（服务不全或插件尚未加载）时为 undefined。 */
export function sideAsk() {
    return client;
}
// ── 待回填的旁路会话草稿 ──────────────────────────────────────────────────
//
// 「开侧栏追问」的用户预期是：**把气泡里的文本带进侧栏会话的输入框，
// 但不要自动发送**——什么时候发由用户自己决定。
//
// 实现借自 dsh-turn-actions 验证过的机制：
//   1. 点击时把文本按 childSessionId 存进这个 Map；
//   2. 注册一个 `conversation.input.left` 条目（session-scoped，无可见界面）；
//   3. 子会话的 composer 一挂载，就从中取到文本并 setDraft，然后删掉本条。
//
// 之所以不走「host 侧 queuePrompt 直接发」：那条路会让消息立刻进对话流，
// 与「不要发送」的预期相反；且 coldResume 要求子会话已落盘，多一层依赖。
//
// 带 TTL：fork 后用户长时间没打开侧栏的话，过期文本直接丢弃，
// 避免陈旧内容在某个意想不到的时刻突然冒出来。
/** 草稿有效期：超过就丢弃，避免陈旧文本突袭。 */
const DRAFT_TTL_MS = 5 * 60 * 1000;
/** childSessionId → 待回填的草稿。 */
const pendingDrafts = new Map();
/** 登记一条待回填草稿（由「开侧栏追问」调用）。 */
export function stagePendingDraft(sessionId, text) {
    if (typeof sessionId !== 'string' || sessionId === '')
        return;
    if (text.trim() === '')
        return;
    pendingDrafts.set(sessionId, { text, at: Date.now() });
}
/** 取走并删除某会话的待回填草稿；没有或已过期则返回 undefined。 */
export function takePendingDraft(sessionId) {
    const entry = pendingDrafts.get(sessionId);
    if (entry === undefined)
        return undefined;
    pendingDrafts.delete(sessionId);
    if (Date.now() - entry.at > DRAFT_TTL_MS)
        return undefined;
    return entry.text;
}
