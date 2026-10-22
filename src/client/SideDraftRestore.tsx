import { useEffect } from 'react'
import type { ReactElement } from 'react'

import { takePendingDraft } from './sideAskStore.ts'

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
export function SideDraftRestore({
  sessionId,
  inputActions,
}: {
  sessionId?: string
  inputActions?: { setDraft: (text: string) => void }
}): ReactElement | null {
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined

    // 草稿是「开侧栏追问」在 RPC **返回之后**才 stage 的，而本条目在
    // composer 挂载时就执行——两者存在竞态：openSideAsk 触发的 React 渲染
    // 与 await 之后的同步代码谁先谁后并不由我们决定。首次取不到就按固定
    // 步长重试，覆盖「composer 先挂载」那一侧，避免文本静默丢失。
    const RETRIES = 6
    const STEP_MS = 100
    // 延后一帧：composer 刚挂载时输入机可能还没就绪，
    // 立即写会被丢弃（dsh-selection-ask 0.1.3 修光标问题时踩过同样的坑）。
    const WRITE_DELAY_MS = 80

    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = () => {
      const text = takePendingDraft(sessionId)
      if (text === undefined) {
        attempt += 1
        if (attempt < RETRIES) timer = setTimeout(run, STEP_MS)
        return
      }
      timer = setTimeout(() => {
        try {
          inputActions?.setDraft(text)
        } catch {
          // 回填失败不影响会话本身：用户在侧栏里手动问一句即可。
        }
      }, WRITE_DELAY_MS)
    }

    run()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, inputActions])

  return null
}
