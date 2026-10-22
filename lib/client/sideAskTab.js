import { Fragment, jsx } from 'react/jsx-runtime';
import { describeSideAskError } from "./sideAskClient.js";
import { sideAsk } from "./sideAskStore.js";
/**
 * 右侧栏「旁路会话」tab。
 *
 * 目标：在右侧栏里渲染「另一个会话的完整官方对话」——输入框、工具卡片、
 * 审批、流式渲染全部复用官方那一套，不自己画。
 *
 * 实现照官方子代理对话（ui-subagent 的 registerSidebarChat）那一套，
 * 因为那是右侧栏嵌入另一个会话对话的唯一正路。但有两处**必须**与官方不同，
 * 否则插件根本加载不起来（slot 系统对重复注册是抛异常，不是覆盖）：
 *
 *   1. `sidebar.chat.conversation` 是 single 插槽，官方子代理 tab 已经占用。
 *      SlotCore.register 对 single 插槽遇到同优先级占用会直接 throw
 *      （`single slot ... already has a registration`）。
 *      → 本插件声明并使用**自己的**子插槽 `side-ask.conversation`。
 *
 *   2. `sidebar.right.pane.tab` 的 `children` 表同样会查重
 *      （`slot ... is already declared`），所以子插槽名绝不能撞官方的。
 *
 * 于是链路变成：
 *   资源协议 side-ask ──→ tab 类型 side-ask ──→ tab 正文（自己的 key）
 *       └─ children 声明独有子插槽 side-ask.conversation
 *            └─ 正文里 renderSlot 渲染它，内容 = 官方 conversation.content 工厂
 */
/** 资源协议名。 */
const SIDE_ASK_PROTOCOL = 'side-ask';
/** tab 类型 id，也是 `sidebar.right.pane.tab` 的 key。 */
export const SIDE_ASK_TAB_ID = 'side-ask';
/** 资源地址前缀。 */
export const SIDE_ASK_ADDRESS = `dsh-resource://${SIDE_ASK_PROTOCOL}/session/`;
/**
 * 本插件独有的子插槽名。
 * 不能用官方的 `sidebar.chat.conversation`——那是 single 插槽且已被占用，
 * 重复注册会抛异常。加插件自己的前缀即可既表达同一用途又避开冲突。
 */
const SIDE_ASK_CONVERSATION_SLOT = 'side-ask.conversation';
/** 把地址字符串解析成 `{ sessionId }`，不合法返回 undefined。 */
export function parseSideAskAddress(address) {
    if (typeof address !== 'string' || !address.startsWith(SIDE_ASK_ADDRESS))
        return undefined;
    // 地址形如 dsh-resource://side-ask/session/<id>[?查询]，只取路径末段。
    const sessionId = address.slice(SIDE_ASK_ADDRESS.length).split('?', 1)[0] ?? '';
    return sessionId === '' ? undefined : { kind: 'session', sessionId };
}
/** 由 sessionId 生成资源地址。 */
export function sideAskAddressFor(sessionId) {
    return `${SIDE_ASK_ADDRESS}${encodeURIComponent(sessionId)}`;
}
/**
 * 固定为 Chat 视图的嵌入对话。
 * 与官方子代理 tab 同一处理：把局部 View 钉在 chat，省略主会话的页头与宽度控制。
 */
function FixedChatConversationView(props) {
    return jsx(Fragment, {
        children: props.renderSlot('conversation.session', { view: 'chat' }),
    });
}
/**
 * 渲染官方对话工厂 `conversation.content`。
 *
 * `variant: 'embedded'` 是官方给「嵌在别处的一次对话」用的形态；
 * phase 与官方一致：settling（还在加载）→ hero（空白会话）→ active。
 * 旁路会话总是带着父会话前缀，所以正常路径就是 active。
 */
function SideAskConversation(props) {
    const session = props.useSession((value) => value);
    const conversation = props.useConversation((value) => value);
    const sessions = props.useSessions((state) => state);
    const active = (conversation?.activeTargets?.size ?? 0) > 0 || !session?.blank;
    const shellPhase = active ? 'active' : session?.promptAttempted ? 'engaging' : 'blank';
    const summaryBlank = sessions?.byId?.[props.sessionId]?.blank;
    const settling = shellPhase === 'blank' && session?.openState === 'loading' && summaryBlank !== true;
    const hero = shellPhase === 'blank' && (session?.openState === 'open' || summaryBlank === true);
    const rendered = props.renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
    }, { slots: { views: FixedChatConversationView } });
    return (rendered ?? null);
}
/**
 * tab 正文。
 *
 * ⚠️ 结构上有个必须遵守的约束：**`SessionProvider` 必须无条件挂载**。
 *
 * 曾经写成「`resource.value === undefined` 就先 return null、有了再渲染
 * SessionProvider」，结果 React 报 #310（Rendered more hooks than during the
 * previous render）：resource 从「未就绪」变成「就绪」时整棵树的 hooks
 * 数量变了。SessionProvider 内部是带 hooks 的组件，不能时而挂载时而消失。
 *
 * 所以这里是「SessionProvider 始终渲染，未就绪的判断放进它的 children」。
 */
function SideAskTab(props) {
    const { tab } = props.useTabInfo();
    const resource = props.useResource(tab.contentId);
    const ready = resource.value !== undefined;
    // SessionProvider 无条件挂载；只有它的 children 随就绪状态变化。
    // 会话引用未就绪时给一个空占位，就绪后才渲染真正的对话。
    return jsx('div', {
        'data-side-ask': '',
        className: 'dsq-side-ask',
        children: props.SessionProvider({
            session: ready ? resource.value.reference : undefined,
            children: ready
                ? props.renderSlot(SIDE_ASK_CONVERSATION_SLOT, {})
                : jsx('div', { className: 'dsq-side-ask-loading', children: '正在载入会话…' }),
        }),
    });
}
/**
 * 资源提供者：`open()` 里 retain 目标会话，tab 关闭时 release。
 * 与官方 subagent 资源同构——直接按地址取引用，不刷新任何目录。
 */
function sideAskResourceProvider(sessions) {
    return {
        protocol: SIDE_ASK_PROTOCOL,
        async *open(resourceAddress, { signal }) {
            const address = parseSideAskAddress(resourceAddress);
            if (address === undefined) {
                throw new Error(`dsh-selection-ask: 非法旁路会话地址 "${resourceAddress}"`);
            }
            if (signal.aborted)
                return;
            // target 必须是 SessionId（字符串）或 SubagentAddress。
            // 不要自己发明 `{ kind:'session', sessionId }` 这类形状：
            // resolveTarget 只认 `target.childSessionId`，自造形状会解析出 undefined，
            // 于是 SessionProvider 拿不到 sessionId，插槽渲染报
            // `uiSession.provide: missing prop 'sessionId'` 并渲染成空白。
            const reference = sessions.retain(address.sessionId, {
                source: 'sideAsk',
                signal,
            });
            try {
                yield { ok: true, value: { address, reference } };
                // 资源存活期与 tab 记录绑定：tab 关闭 → signal 触发 → finally 释放引用。
                await new Promise((resolve) => {
                    if (signal.aborted) {
                        resolve();
                        return;
                    }
                    signal.addEventListener('abort', () => resolve(), { once: true });
                });
            }
            finally {
                reference.release();
            }
        },
    };
}
/** 外层容器样式（对话本体是官方的，这里只保证容器能吃满高度）。 */
const SIDE_ASK_CSS = `
.dsq-side-ask {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.dsq-side-ask-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 16px;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  font-size: 13px;
}
/*
 * 开始页入口胶囊。
 *
 * 只使用已发布的主题 token catalog（Theme.listTokens 那 14 个）。
 * 踩过的坑：用过 catalog 外的 --dsw-alias-label-tertiary 等名字，
 * 出厂主题上解析不出值，浅色主题下图标/文字几乎不可见。
 */
.dsq-guide-entry {
  box-sizing: border-box;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 88px;
  max-width: 132px;
  padding: 14px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.04));
  color: var(--dsw-alias-label-primary, #1f2329);
  font: inherit;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.dsq-guide-entry:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08));
}
.dsq-guide-entry:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsq-guide-entry:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
.dsq-guide-entry-glyph {
  display: inline-flex;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
}
.dsq-guide-entry-glyph svg {
  width: 22px;
  height: 22px;
}
.dsq-guide-entry-text {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
}
.dsq-guide-entry-desc {
  font-size: 11px;
  line-height: 1.35;
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  text-align: center;
}
`;
/** 注入样式，随 fiber 生命周期清理。 */
function injectStyle(ctx) {
    ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-selection-ask';
        tag.dataset.pluginCss = 'dsh-selection-ask/side-ask.css';
        tag.textContent = SIDE_ASK_CSS;
        document.head.appendChild(tag);
        return () => {
            tag.remove();
        };
    }, 'dsh-selection-ask: side-ask css');
}
/**
 * 挂载右侧栏旁路会话 tab。
 *
 * @param ctx - 需要 `resources`、`sessions`、`slots`、`sidebarRightTabs` 四个 client 服务。
 * @returns 打开一个旁路会话 tab 的函数；服务不全时返回 undefined（插件其余部分仍可用）。
 */
export function mountSideAskTab(ctx) {
    const slots = ctx.get('slots');
    const sessions = ctx.get('sessions');
    const resources = ctx.get('resources');
    const sidebarRightTabs = ctx.get('sidebarRightTabs');
    const sidebarRight = ctx.get('sidebarRight');
    // 服务不全是降级而不是抛错：选中追问等其余功能不该被右侧栏能力拖垮。
    if (slots === undefined || resources === undefined || sidebarRightTabs === undefined) {
        return undefined;
    }
    injectStyle(ctx);
    // 1. 资源协议：地址 → 会话引用。
    ctx.effect(() => resources.register(sideAskResourceProvider(sessions)), 'dsh-selection-ask: side-ask resources');
    // 2. tab 类型声明：认哪类地址、标题怎么取。
    //
    //    `guide` 字段让这个类型在右侧栏「开始页」贡献一个入口胶囊。
    //    没有它，侧栏开始页只有官方那几个类型，用户想开旁路会话
    //    只能先去选中文本——多了几步。
    ctx.effect(() => sidebarRightTabs.register({
        id: SIDE_ASK_TAB_ID,
        kind: SIDE_ASK_PROTOCOL,
        patterns: [`${SIDE_ASK_ADDRESS}**`],
        priority: 'addon',
        canOpen: (address) => parseSideAskAddress(address) !== undefined,
        title: (address) => {
            const parsed = parseSideAskAddress(address);
            if (parsed === undefined)
                return '旁路会话';
            // 标题优先用会话自己的标题；还没生成出来时退回固定文案。
            const title = sessions.list.getSnapshot().byId[parsed.sessionId]?.title;
            return typeof title === 'string' && title !== '' ? title : '旁路会话';
        },
        // 开始页入口。框架会把 kind / providerId 补到每个 entry 上，
        // 点击行为由 `sidebar.right.tab.guide.entry`（key = providerId）
        // 的注册者定制——默认的 onPick 只开一个空 tab，满足不了
        // 「发起对话」（需要先 fork 再用 address 打开）。
        guide: [
            {
                id: 'side-ask-start',
                order: 20,
                title: () => '发起旁路对话',
                // 描述只在入口不超过 4 个时显示，这里压到一句以内。
                description: () => '继承当前上下文，不打断主会话',
            },
        ],
    }), 'dsh-selection-ask: side-ask tab type');
    // 2b. 开始页入口的定制点击行为。
    //
    //     `sidebar.right.tab.guide.entry` 是 keyed 插槽，key = providerId
    //     （即上面注册的 tab 类型 id）。注册自己的渲染器即可接管点击：
    //     fork 一个旁路会话 → 用它的 address 打开 tab。
    //     不注册的话会走官方 fallback（只 openTab 开空 tab）。
    ctx.effect(() => slots.inject('sidebar.right.tab.guide.entry', () => slots.register({
        name: 'sidebar.right.tab.guide.entry',
        key: SIDE_ASK_TAB_ID,
    }, (props) => jsx(SideAskGuideEntry, { ...props, openSideSession: openViaGuide }))), 'dsh-selection-ask: side-ask guide entry');
    // 3. tab 正文。子插槽用本插件独有的名字，避开官方 single 插槽冲突。
    ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: SIDE_ASK_TAB_ID,
        children: {
            [SIDE_ASK_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
        },
    }, (props) => jsx(SideAskTab, { ...props }))), 'dsh-selection-ask: side-ask tab body');
    // 4. 本 tab 内部的对话内容：官方 conversation.content 工厂。
    ctx.effect(() => slots.inject(SIDE_ASK_CONVERSATION_SLOT, () => slots.register({ name: SIDE_ASK_CONVERSATION_SLOT }, (props) => jsx(SideAskConversation, { ...props }))), 'dsh-selection-ask: side-ask conversation');
    // 打开旁路会话用的是 `openResource`（资源地址 dsh-resource://…），
    // 不是 `openTab`——后者是给「页面类型」用的，参数是 kind 而非地址。
    const openBySessionId = (sessionId) => {
        if (typeof sidebarRight?.openResource !== 'function')
            return;
        sidebarRight.openResource(sideAskAddressFor(sessionId));
    };
    // 开始页入口的点击行为：fork 一个旁路会话并用它的 address 打开。
    // 与「选中追问」的差别只有一点——没有预填草稿（用户没选中任何文本），
    // 开的是一个空的旁路会话，想聊什么直接打。
    const openViaGuide = async (currentSessionId) => {
        const client = sideAsk();
        if (client === undefined || typeof currentSessionId !== 'string' || currentSessionId === '') {
            return;
        }
        try {
            const result = await client.openSideSession({
                parentSessionId: currentSessionId,
                agentPreset: undefined,
            });
            // 落盘失败要在浏览器控制台大声报——host 的 console 到不了页面，
            // 这是用户唯一能看到失败原因的地方。
            if (result.persist !== undefined && result.persist.ok !== true) {
                console.error(`[dsh-selection-ask] 旁路会话未落盘，侧栏发送将报 SessionPersistenceNotFoundError：` +
                    `${result.persist.error ?? '未知原因'}`);
            }
        }
        catch (error) {
            // 开始页不该弹错误条（会打断用户），只记日志。
            console.warn('[dsh-selection-ask] 开始页发起旁路对话失败:', describeSideAskError(error));
        }
    };
    return openBySessionId;
}
/**
 * 开始页里的「发起旁路对话」入口。
 *
 * 官方默认渲染器（EntryBox）点击后只 `openTab(kind)` 开一个**空 tab**——
 * 没有 address，SideAskTab 会一直停在「正在载入会话」。
 * 所以这里自己画一个胶囊：点击先 fork 旁路会话，再用 address 打开。
 *
 * props 由框架传入：`entryId` / `kind` / `title` / `description`（来自 tab 注册的
 * guide 字段），加上 session 标准 kit 里的 `sessionId`（当前会话）。
 */
function SideAskGuideEntry(props) {
    const title = typeof props.title === 'function' ? props.title() : props.title;
    const description = typeof props.description === 'function' ? props.description() : props.description;
    const onClick = () => {
        if (typeof props.sessionId === 'string' && props.sessionId !== '') {
            void props.openSideSession?.(props.sessionId);
        }
    };
    const disabled = typeof props.sessionId !== 'string' || props.sessionId === '';
    return jsx('button', {
        type: 'button',
        className: 'dsq-guide-entry',
        disabled,
        title: disabled ? '需要先打开一个会话' : '开一个继承当前上下文的旁路会话，不打断主会话',
        onClick,
        children: [
            jsx('span', { key: 'glyph', className: 'dsq-guide-entry-glyph', 'aria-hidden': true,
                children: jsx('svg', {
                    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
                    children: [
                        jsx('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }, 'a'),
                    ],
                }) }),
            jsx('span', { key: 'text', className: 'dsq-guide-entry-text', children: title ?? '发起旁路对话' }),
            description === undefined
                ? null
                : jsx('span', { key: 'desc', className: 'dsq-guide-entry-desc', children: description }),
        ],
    });
}
