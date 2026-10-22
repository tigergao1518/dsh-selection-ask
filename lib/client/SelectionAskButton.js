import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, } from 'react';
import { appendQuote, buildQuote } from "./quote.js";
import { describeSideAskError } from "./sideAskClient.js";
import { sideAsk, stagePendingDraft } from "./sideAskStore.js";
/** Gap (px) between the selection edge and the floating surface. */
const GAP = 8;
/** Viewport edge padding (px) used when clamping the floating position. */
const MARGIN = 8;
/** 取元素所属的会话根：`[data-conversation-scroll]` 就是整个会话面板。 */
function conversationRootOf(node) {
    return node?.closest('[data-conversation-scroll]') ?? null;
}
/**
 * Read the current DOM selection when it qualifies for quoting: non-empty,
 * inside the conversation transcript (`[data-conversation-scroll]`) OR inside
 * an in-app document preview (`[data-document-preview]` / the rendered
 * markdown body / a text preview tab), but NOT inside the composer card
 * (quoting the draft back into itself is nonsense). Returns null otherwise —
 * including selections scrolled fully off-screen.
 *
 * `ownRoot` is the conversation this button instance belongs to (resolved from
 * its persistent anchor). Selections belonging to another conversation are
 * rejected — see the check below.
 */
function readSelection(ownRoot) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
        return null;
    const text = selection.toString().trim();
    if (!text)
        return null;
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.ELEMENT_NODE
        ? ancestor
        : ancestor.parentElement;
    if (!node)
        return null;
    const inTranscript = node.closest('[data-conversation-scroll]');
    const inDocPreview = node.closest('[data-document-preview]') ||
        node.closest('[data-document-markdown]') ||
        node.closest('[data-textpreview-state]');
    if (!inTranscript && !inDocPreview)
        return null;
    if (node.closest('[data-composer-card]'))
        return null;
    // 会话隔离**只对 transcript 里的选区生效**。
    //
    // 多会话同屏（侧边栏开着旁路会话）时，每个会话的 composer 都会挂一个
    // SelectionAskButton——`conversation.input.overlay` 是 session-scoped 的
    // 列表插槽。这些实例监听的是同一个全局 selectionchange、读到的是同一个
    // 选区，于是两个 pill 会被算到同一个位置重叠；用户点到的可能是另一个
    // 会话的那个按钮，「存入本会话」就把引用写进了错误的输入框。
    //
    // 文档预览**不做**这个比对：它可能渲染在侧边栏之类的容器里，
    // 根本不属于任何会话面板，没有可比的会话根。对它做比对会把
    // 「在文件预览里选中文本」这条原有能力整个废掉。
    if (inTranscript && (ownRoot === null || conversationRootOf(node) !== ownRoot)) {
        return null;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0)
        return null;
    if (rect.right < 0 ||
        rect.bottom < 0 ||
        rect.left > window.innerWidth ||
        rect.top > window.innerHeight) {
        return null;
    }
    return { text, rect };
}
/**
 * The floating 「询问 DeepSeek」 surface.
 *
 * 两种用法，由卡片上的两个按钮区分：
 *
 *   「开侧栏追问」—— 在右侧栏开一个旁路会话：它 fork 自主会话、
 *     继承到目前为止的上下文，但有自己的对话流。主会话不被打断，
 *     侧栏里的问答也不会写回主会话的模型上下文。适合「问一下但不打断手头活」。
 *
 *   「存入本会话」—— 原有行为：把引用追加到当前输入框草稿，
 *     由用户自己决定何时发出去。适合「这段我要在主线里讨论」。
 *
 * 侧栏按钮在右侧栏服务不可用时隐藏，不给用户一个点了没反应的入口。
 */
export function SelectionAskButton({ useInput, inputActions, sessionId, }) {
    const draft = useInput((s) => s.draft);
    const [sel, setSel] = useState(null);
    const [mode, setMode] = useState('pill');
    const [pos, setPos] = useState(null);
    const [text, setText] = useState('');
    const [notice, setNotice] = useState('');
    const [sideAvailable, setSideAvailable] = useState(false);
    const pillRef = useRef(null);
    const cardRef = useRef(null);
    // 持久锚点：零尺寸、不可见，唯一用途是让本实例能确定「自己属于哪个会话」
    // （见 readSelection 里的会话比对）。必须始终渲染，否则 sel 为 null 时
    // 拿不到会话根，多会话同屏下的会话隔离就失效了。
    const anchorRef = useRef(null);
    // Compose guards selection tracking: edits inside the card must not let a
    // stray selectionchange swap the surface back to the pill mid-typing.
    const composingRef = useRef(false);
    // 右侧栏能力是运行时才知的（依赖若干 client 服务是否齐全），
    // 所以在挂载后探一次，不在渲染期猜。
    useEffect(() => {
        setSideAvailable(sideAsk() !== undefined);
    }, []);
    const updateSelection = useCallback(() => {
        if (composingRef.current)
            return;
        // 会话根从持久锚点上取：它随组件一起挂载，切分支不会被卸载。
        setSel(readSelection(conversationRootOf(anchorRef.current)));
    }, []);
    // Track selection lifecycle: drag-release, keyboard selection, programmatic
    // clears (selectionchange), plus scroll/resize so the fixed surface tracks
    // the selection rect and hides once it leaves the viewport.
    useEffect(() => {
        document.addEventListener('selectionchange', updateSelection);
        document.addEventListener('mouseup', updateSelection);
        document.addEventListener('keyup', updateSelection);
        document.addEventListener('scroll', updateSelection, {
            capture: true,
            passive: true,
        });
        window.addEventListener('resize', updateSelection);
        return () => {
            document.removeEventListener('selectionchange', updateSelection);
            document.removeEventListener('mouseup', updateSelection);
            document.removeEventListener('keyup', updateSelection);
            document.removeEventListener('scroll', updateSelection, { capture: true });
            window.removeEventListener('resize', updateSelection);
        };
    }, [updateSelection]);
    // Measure the rendered surface (pill or card), then clamp its position into
    // the viewport. Runs before paint, so the off-screen measuring frame is
    // never shown.
    useLayoutEffect(() => {
        // compose 与 sending 都渲染卡片，用 cardRef 测量；pill 用 pillRef。
        const el = mode === 'pill' ? pillRef.current : cardRef.current;
        if (!sel || !el) {
            setPos(null);
            return;
        }
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        let left = sel.rect.right - w;
        let top = sel.rect.top - h - GAP;
        if (top < MARGIN)
            top = sel.rect.bottom + GAP;
        left = Math.min(Math.max(MARGIN, left), window.innerWidth - w - MARGIN);
        top = Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN);
        setPos({ top, left });
    }, [sel, mode]);
    // Focus the card textarea the moment compose mounts; caret parked at the
    // end of the pre-filled quote so typing starts immediately.
    useEffect(() => {
        if (mode !== 'compose')
            return;
        const ta = cardRef.current?.querySelector('textarea');
        if (ta) {
            ta.focus({ preventScroll: true });
            ta.setSelectionRange(ta.value.length, ta.value.length);
        }
    }, [mode]);
    const close = useCallback(() => {
        composingRef.current = false;
        setMode('pill');
        setSel(null);
        setPos(null);
        setText('');
        setNotice('');
    }, []);
    const openCompose = useCallback(() => {
        if (!sel)
            return;
        composingRef.current = true;
        setText(buildQuote(sel.text) + '\n\n');
        setNotice('');
        setMode('compose');
        window.getSelection()?.removeAllRanges();
    }, [sel]);
    /** 「存入本会话」：把引用追加到当前输入框草稿，由用户自己发。 */
    const save = useCallback(() => {
        const body = text.trim();
        if (!body) {
            close();
            return;
        }
        inputActions.setDraft(appendQuote(draft, body));
        close();
    }, [text, draft, inputActions, close]);
    /**
     * 「开侧栏追问」：fork 主会话到当前轮，在右侧栏开一个旁路会话，
     * 并把「引用 + 问题」**带进那个会话的输入框，但不发送**。
     *
     * 继承边界取当前会话最后一条事件（host 侧省略 atSeq 即取最新），
     * 所以侧栏会话拿得到主会话到目前为止的全部上下文；
     * 追问沿用主会话的预设与模型，问完即弃。
     */
    const askInSidebar = useCallback(async () => {
        const body = text.trim();
        if (!body) {
            close();
            return;
        }
        const client = sideAsk();
        if (client === undefined || typeof sessionId !== 'string' || sessionId === '') {
            setNotice('当前会话不可用，无法开侧栏追问');
            return;
        }
        setMode('sending');
        setNotice('正在准备侧栏会话…');
        try {
            const result = await client.openSideSession({
                parentSessionId: sessionId,
                // 追问沿用主会话的预设与模型，问完即弃，不需要只读那一套。
                agentPreset: undefined,
            });
            // 把「引用 + 问题」带给新会话的输入框；不发送，由用户自己决定。
            stagePendingDraft(result.sessionId, body);
            // 落盘失败必须让用户立刻知道：否则他在侧栏打完字一发送，
            // 只会看到一句莫名的 SessionPersistenceNotFoundError。
            if (result.persist !== undefined && result.persist.ok !== true) {
                setNotice(`侧栏会话未能落盘，发送可能失败：${result.persist.error ?? '未知原因'}`);
                return;
            }
            close();
        }
        catch (error) {
            setMode('compose');
            setNotice(describeSideAskError(error));
        }
    }, [text, sessionId, close]);
    const onCardKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // Enter 走主按钮（存入本会话）。侧栏追问是次级动作，需要显式点。
            save();
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    };
    // 锚点必须**始终**渲染——包括有选区的时候：readSelection 的会话隔离依赖
    // anchorRef 随时能拿到自己所属的会话根。把它作为每个分支的第一个子元素，
    // React 会稳定复用同一个 DOM 节点，切分支时不会卸载它。
    const anchor = _jsx("span", { ref: anchorRef, "aria-hidden": "true", className: "dsa-anchor" });
    if (!sel)
        return anchor;
    const style = pos
        ? { position: 'fixed', top: pos.top, left: pos.left }
        : { position: 'fixed', top: -9999, left: -9999, opacity: 0 };
    // 发送中：只显示进度，不显示可点的按钮，避免重复创建旁路会话。
    if (mode === 'sending') {
        return (_jsxs(_Fragment, { children: [anchor, _jsx("div", { ref: cardRef, className: "dsa-card", style: style, onMouseDown: (event) => event.stopPropagation(), children: _jsx("div", { className: "dsa-card-status", children: notice || '正在准备侧栏会话…' }) })] }));
    }
    if (mode === 'compose') {
        return (_jsxs(_Fragment, { children: [anchor, _jsxs("div", { ref: cardRef, className: "dsa-card", style: style, onMouseDown: (event) => event.stopPropagation(), children: [_jsx("textarea", { className: "dsa-card-input", value: text, onChange: (event) => setText(event.target.value), onKeyDown: onCardKeyDown, placeholder: "\u8865\u5145\u4F60\u7684\u95EE\u9898\u6216\u8BC4\u8BBA\u2026" }), notice !== '' && _jsx("div", { className: "dsa-card-error", children: notice }), _jsxs("div", { className: "dsa-card-actions", children: [_jsx("span", { className: "dsa-card-hint", children: sideAvailable
                                        ? 'Enter 存入本会话 · Shift+Enter 换行 · Esc 取消'
                                        : 'Enter 保存 · Shift+Enter 换行 · Esc 取消' }), _jsx("button", { type: "button", className: "dsa-card-btn", 
                                    // Keep the click from clearing the textarea focus.
                                    onMouseDown: (event) => event.preventDefault(), onClick: close, children: "\u53D6\u6D88" }), sideAvailable && (_jsx("button", { type: "button", className: "dsa-card-btn", onMouseDown: (event) => event.preventDefault(), onClick: () => void askInSidebar(), title: "\u5728\u53F3\u4FA7\u680F\u5F00\u4E00\u4E2A\u7EE7\u627F\u5F53\u524D\u4E0A\u4E0B\u6587\u7684\u65B0\u4F1A\u8BDD\u8FFD\u95EE\uFF0C\u4E0D\u6253\u65AD\u4E3B\u4F1A\u8BDD", children: "\u5F00\u4FA7\u680F\u8FFD\u95EE" })), _jsx("button", { type: "button", className: "dsa-card-btn dsa-card-btn-primary", onMouseDown: (event) => event.preventDefault(), onClick: save, title: "\u628A\u5F15\u7528\u8FFD\u52A0\u5230\u5F53\u524D\u4F1A\u8BDD\u7684\u8F93\u5165\u6846\uFF0C\u7531\u4F60\u51B3\u5B9A\u4F55\u65F6\u53D1\u9001", children: "\u5B58\u5165\u672C\u4F1A\u8BDD" })] })] })] }));
    }
    return (_jsxs(_Fragment, { children: [anchor, _jsx("button", { ref: pillRef, type: "button", className: "dsa-button", style: style, 
                // Keep the text selection alive across the click: prevent the pill from
                // stealing focus/collapsing the selection on mousedown.
                onMouseDown: (event) => event.preventDefault(), onClick: openCompose, children: "\u8BE2\u95EE DeepSeek" })] }));
}
