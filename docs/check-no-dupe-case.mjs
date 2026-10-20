// 防回归：switch 里不允许出现同名 case 重复。
// JS 的 switch 只执行第一个匹配的 case，后面同名的永远不会跑。
// 曾因在 switch 顶部插入「组成统计」的 case，把原有的 user/message、
// assistant/message、tool/result、system/message 全部遮蔽，导致
// token 累计、报错统计、提问识别静默失效（输出全是 0）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]?.trim() || join(process.cwd(), 'dsh-selection-ask')
const problems = []

function check(label, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

const src = readFileSync(join(root, 'src', 'sessionDigest.ts'), 'utf8')

// 只取 digestSession 函数体（到下一个 export 为止）
const start = src.indexOf('export function digestSession')
const end = src.indexOf('export function renderDigest')
if (start < 0 || end < 0) {
  console.error('找不到 digestSession / renderDigest')
  process.exit(1)
}
const body = src.slice(start, end)

// 抽出所有 case 标签
const cases = [...body.matchAll(/case\s+'([^']+)'\s*:/g)].map((m) => m[1])
check('能找到 case 标签', cases.length > 0, `${cases.length} 个`)

const seen = new Map()
const dupes = []
for (const c of cases) {
  seen.set(c, (seen.get(c) ?? 0) + 1)
}
for (const [c, n] of seen) {
  if (n > 1) dupes.push(`${c} × ${n}`)
}
check('无同名 case 重复（JS 只跑第一个，后面的静默失效）',
  dupes.length === 0, dupes.join(', '))

// 关键事件都必须被处理到
for (const needed of [
  'user/message', 'assistant/message', 'tool/result', 'tool/call',
  'turn/start', 'turn/end', 'step/start', 'llm/retry',
  'system/message', 'request/header', 'request/context',
  'compaction/start', 'agent/inbox/spliced',
]) {
  check(`处理了 ${needed}`, seen.has(needed))
}

console.log(`\n${problems.length === 0 ? '全部通过' : `失败 ${problems.length} 项：${problems.join('、')}`}`)
process.exit(problems.length === 0 ? 0 : 1)
