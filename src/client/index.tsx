import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { jsx } from 'react/jsx-runtime'
// Type-only module loads so their declaration merges apply in this program:
// - ui-conversation merges `useInput`/`inputActions` into SessionStandardProps;
// - ui-input-trigger declares the `conversation.input.overlay` SlotMap entry;
// - ui-renderer owns the `ctx.slots` service declaration (0.1.5-rc.2 moved it
//   out of the retired dsh-client-runtime).
// All are erased at compile time (purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SelectionAskButton } from './SelectionAskButton.tsx'
import { injectStyle } from './styles.ts'
import { mountSideAskTab } from './sideAskTab.tsx'
import { createSideAskClient, type SideAskClient } from './sideAskClient.ts'
import { setSideAskClient } from './sideAskStore.ts'
import { REVIEW_CSS, ReviewEntry } from './reviewEntry.tsx'
import { SideDraftRestore } from './SideDraftRestore.tsx'

/**
 * Client entry: the browser half of the plugin.
 *
 * 两个能力共用一套「旁路会话」底座：
 *   - 选中追问（原有）：浮动按钮 → 侧边栏追问会话；
 *   - 会话复盘（新增）：会话头入口 → 侧边栏复盘会话（只读预设）。
 *
 * 浏览器半负责全部界面；创建子会话必须由 host 半完成
 * （子 agent 的预设、模型、父子关系都在宿主侧），所以经
 * `createSideAskClient()` 走同源 RPC。
 */
export const inject = ['slots', 'resources', 'sessions', 'sidebarRightTabs', 'sidebarRight']

export function apply(ctx: ClientContext): void {
  // Floating-button CSS as an HMR-safe <style data-plugin> tag (effect-owned).
  injectStyle(ctx)

  // 右侧栏「旁路会话」tab：资源协议 + tab 类型 + 官方对话工厂。
  // 返回打开函数；服务不全时内部降级返回 undefined，不影响其余功能。
  const openSideAsk = mountSideAskTab(ctx)

  // 浏览器半 → host 半的旁路会话创建出入口。
  const client: SideAskClient = createSideAskClient({ openSideAsk })
  setSideAskClient(client)

  // Register into conversation.input.overlay (the zero-height anchor above the
  // composer). slots.inject waits for the declarer (ui-conversation's composer)
  // to come up, then routes the registration (and its unload cascade) through
  // this fiber. The button escapes the anchor with position:fixed.
  ctx.slots.inject(
    'conversation.input.overlay',
    () =>
      ctx.slots.register(
        {
          name: 'conversation.input.overlay',
          id: 'dsh-selection-ask', // list slot: id is required and unique
        },
        SelectionAskButton,
      ),
  )

  // 会话头「复盘本会话」入口：右侧栏只读复盘会话。
  // 入口样式随本 fiber 生命周期注入，热重载不会残留。
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-selection-ask'
    tag.dataset.pluginCss = 'dsh-selection-ask/review-entry.css'
    tag.textContent = REVIEW_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-selection-ask: review entry css')

  // 旁路会话的草稿回填器：无可见界面，只负责在子会话 composer 挂载时
  // 把「开侧栏追问」暂存的文本写进输入框（不发送）。
  // 机制借自 dsh-turn-actions 验证过的 pendingDrafts 方案。
  ctx.slots.inject(
    'conversation.input.left',
    () =>
      ctx.slots.register(
        {
          name: 'conversation.input.left',
          id: 'dsh-selection-ask-draft-restore',
        },
        SideDraftRestore,
      ),
  )

  ctx.slots.inject(
    'conversation.session.header.utilities',
    () =>
      ctx.slots.register(
        {
          name: 'conversation.session.header.utilities',
          id: 'dsh-selection-ask-review',
          order: 20,
        },
        // session-scoped 插槽：组件从 props 里拿 sessionId。
        // cwd 优先取 props；props 没带就从 sessions 快照里查（会话列表里有 cwd）。
        (props: { sessionId?: string; useSession?: unknown; cwd?: string }) => {
          const sessionId = props.sessionId ?? ''
          let cwd = typeof props.cwd === 'string' ? props.cwd : undefined
          if (cwd === undefined && sessionId !== '') {
            try {
              const snap = (ctx.get('sessions') as any)?.list?.getSnapshot?.()
              cwd = snap?.byId?.[sessionId]?.cwd
            } catch {
              // 拿不到就让 ReviewEntry 自己提示失败，不在这里抛。
            }
          }
          return jsx(ReviewEntry, { sessionId, cwd })
        },
      ),
  )
}
