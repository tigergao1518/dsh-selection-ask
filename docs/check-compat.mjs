// 全面排查：插件用到的所有官方 API / 服务 / 插槽，在新版 DSH 里是否还存在、签名是否变化。
//
// 用法：node check-compat.mjs [asar 路径]
//   asar 路径可用第一个参数覆盖，或设 DSH_ASAR 环境变量；
//   都不给则按平台猜默认安装位置。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'

/** 按平台猜 DSH 的 app.asar 位置。 */
function defaultAsarPaths() {
  const home = homedir()
  if (platform() === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
      join(home, 'AppData', 'Local', 'Programs', 'DeepSeek-Harness', 'resources', 'app.asar'),
    ]
  }
  if (platform() === 'darwin') {
    return [join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'app.asar')]
  }
  return [
    join(home, '.local', 'share', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/opt/DeepSeek Harness/resources/app.asar',
  ]
}

const ASAR =
  process.argv[2]?.trim() ||
  process.env.DSH_ASAR?.trim() ||
  defaultAsarPaths().find((p) => existsSync(p)) ||
  defaultAsarPaths()[0]

if (!existsSync(ASAR)) {
  console.error(`找不到 DSH 的 app.asar：${ASAR}`)
  console.error('用法：node check-compat.mjs <asar 路径>，或设 DSH_ASAR 环境变量')
  process.exit(2)
}

const text = readFileSync(ASAR, 'utf8')
const problems = []

function check(label, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

// ── 1. 插件依赖的 host 服务 ─────────────────────────────────────────────
const services = ['webServer', 'sessions', 'agents', 'subagents']
console.log('── host 服务 ──')
for (const s of services) {
  // 服务名在 asar 里以 "sessions" 等形式出现即认为存在（服务注册名）
  const re = new RegExp(`["']${s}["']`, 'g')
  const n = (text.match(re) || []).length
  check(`服务 ${s} 仍存在`, n > 0, `${n} 处引用`)
}

// ── 2. 关键 API 签名 ───────────────────────────────────────────────────
console.log('\n── 关键 API ──')
const apis = [
  ['sessions.fork', /fork\(source,\s*boundary,\s*childSessionId\)/],
  ['sessions.get', /get\(id\)\s*\{/],
  ['agents.create', /async createAgent\(ownerCtx,\s*options\)/],
  ['agents.get', /resolveAgent\(sessionId\)/],
  ['subagents.queuePrompt', /queuePrompt\(/],
  ['session.snapshotEvents', /snapshotEvents\(/],
  ['session.append', /append\(type,\s*data/],
  ['persistence.create', /async create\(header,\s*options\)/],
  ['persistence.open', /open\(id,\s*access/],
]
for (const [name, re] of apis) {
  check(`API ${name}`, re.test(text))
}

// ── 3. 客户端插槽 ──────────────────────────────────────────────────────
console.log('\n── 客户端插槽 ──')
const slots = [
  'conversation.input.overlay',
  'conversation.session.header.utilities',
  'sidebar.right.pane.tab',
  'conversation.input.left',
  'sidebar.right.tab.guide.entry',
]
for (const s of slots) {
  check(`插槽 ${s}`, text.includes(s))
}

// ── 4. 客户端服务 ──────────────────────────────────────────────────────
console.log('\n── 客户端服务 ──')
for (const s of ['sidebarRightTabs', 'sidebarRight', 'resources']) {
  const re = new RegExp(`["']${s}["']`, 'g')
  const n = (text.match(re) || []).length
  check(`服务 ${s}`, n > 0, `${n} 处引用`)
}

// ── 5. 资源协议与地址格式 ──────────────────────────────────────────────
console.log('\n── 资源协议 ──')
check('protocol side-ask 可注册（resources.register）', /register\(/.test(text))
check('openResource 存在', text.includes('openResource'))

// ── 6. 潜在破坏性变化 ─────────────────────────────────────────────────
console.log('\n── 潜在破坏性变化 ──')
// single 插槽仍抛错（我们用 keyed 避开，但要确认 keyed 还支持 children）
check('keyed 插槽仍支持 children', /children/.test(text))
// Theme token catalog
const catalogTokens = [
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary', '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary', '--dsw-alias-state-error-primary',
  '--dsw-specific-sidebar-fill',
]
for (const t of catalogTokens) {
  if (!text.includes(t)) check(`主题 token ${t}`, false, 'asar 里找不到')
}
console.log(`(主题 token 检查完毕，共 ${catalogTokens.length} 个)`)

console.log(`\n${problems.length === 0 ? '全部通过' : `发现 ${problems.length} 个问题：${problems.join('、')}`}`)
process.exit(problems.length === 0 ? 0 : 1)
