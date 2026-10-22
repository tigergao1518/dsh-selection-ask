import type { ReactElement } from 'react'
import { jsx } from 'react/jsx-runtime'

import { describeSideAskError } from './sideAskClient.ts'
import { sideAsk } from './sideAskStore.ts'

/**
 * 会话头「复盘本会话」入口。
 *
 * 点它在右侧栏开一个**只读**复盘会话。三条关键设计：
 *
 * 1. **新开会话，不 fork** —— fork 出的会话已经「开始过」，官方
 *    `agent-preset/locked` 拒绝再切预设，只读约束就落不了地。新开会话的
 *    id 不在 store 里，`meta.agentPreset` 能一步把只读工具集定死。
 *
 * 2. **数据来自日志文件，不是对话继承** —— host 侧读取并解压该会话的
 *    `session.v4.jsonl.zstd`，提炼出每轮 token / 工具调用 / 报错 / 耗时，
 *    作为复盘的第一段输入。这样复盘有据可依，而不是靠模型回忆。
 *
 * 3. **细节可回查** —— 复盘会话挂着 `read_session_log` 工具，需要看某轮
 *    到底发生了什么时按需查原始事件，不必把整份日志塞进上下文。
 *
 * 于是「复盘不占用工作区对话任务」成立：
 *   - 主会话的任务流不被打断，也不被复盘内容污染；
 *   - 复盘会话的工具集是只读的，即便跑偏也碰不坏工作区；
 *   - 复盘结论由人带回主会话，而不是自动写回去。
 *
 * 挂载点：`conversation.session.header.utilities`（会话头右侧功能区，
 * 官方 schedule 插件也在这里注册条目）。
 */

/** 图标：回看时钟（描边风格，与官方图标行一致）。 */
function ReviewIcon(): ReactElement {
  return jsx('svg', {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    children: [
      jsx('path', { d: 'M3 12a9 9 0 1 0 3-6.7' }, 'a'),
      jsx('path', { d: 'M3 4v5h5' }, 'b'),
      jsx('path', { d: 'M12 7v5l4 2' }, 'c'),
    ],
  })
}

/** 复盘入口按钮。 */
export function ReviewEntry({
  sessionId,
  cwd,
}: {
  sessionId: string
  /** 当前会话的工作目录；复盘会话要有自己的 cwd，必须是绝对路径。 */
  cwd?: string
}): ReactElement {
  const onClick = async () => {
    const client = sideAsk()
    if (client === undefined || typeof sessionId !== 'string' || sessionId === '') return
    if (typeof cwd !== 'string' || cwd === '') {
      console.warn('[dsh-selection-ask] 复盘入口拿不到会话的工作目录，无法新开复盘会话')
      return
    }
    try {
      // 复盘走 openReviewSession，不是 openSideSession：
      // 前者新开会话 + 指定只读预设（真正生效）+ 由 host 读日志注入过程数据。
      await client.openReviewSession({ targetSessionId: sessionId, cwd })
    } catch (error) {
      // 入口本身不显示错误条（会话头空间宝贵），失败时只记日志，
      // 用户看不到右侧栏出现新 tab 就知道没成功。
      console.warn('[dsh-selection-ask] 复盘入口失败:', describeSideAskError(error))
    }
  }

  return jsx('button', {
    type: 'button',
    className: 'dsq-review-btn',
    title: '在右侧栏开一个只读复盘会话：读本会话的日志分析报错、上下文、跑偏与可回退点，不碰工作区',
    'aria-label': '复盘本会话',
    onClick: () => void onClick(),
    children: jsx(ReviewIcon, {}),
  })
}

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
export const REVIEW_CSS = `
.dsq-review-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  /* label-secondary 在 catalog 内；tertiary 不在，勿用。 */
  color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55));
  cursor: pointer;
}
.dsq-review-btn svg {
  width: 15px;
  height: 15px;
}
.dsq-review-btn:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.05));
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dsq-review-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe);
  outline-offset: 2px;
}
`
