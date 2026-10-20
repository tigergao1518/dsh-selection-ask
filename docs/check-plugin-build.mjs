// 构建产物完整性校验：banner 协议、新模块、purity gate、host 半、两侧路由一致。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// 插件目录可用第一个参数覆盖，默认仓库内的 dsh-selection-ask。
// 该目录按仓库惯例被 gitignore（第三方插件的本地副本，单独管理），
// 所以这里从仓库根拼路径，而不是把它当作受版本控制的源码。
const root = process.argv[2]?.trim() || join(process.cwd(), 'dsh-selection-ask')
const problems = []

function check(label, ok, detail = '') {
  console.log(`${ok ? '通过' : '失败'}：${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

const read = (f) => readFileSync(`${root}/lib/${f}`, 'utf8')

// ── host 半 ───────────────────────────────────────────────────────────────
for (const f of ['index.js', 'sideSession.js', 'sideAskRpc.js']) {
  check(`host 产物 ${f}`, existsSync(`${root}/lib/${f}`))
}

const hostIndex = read('index.js')
check('host 入口声明注入 webServer', /inject\s*=\s*\[[^\]]*webServer/.test(hostIndex))
check('host 入口在 effect 中注册 exact 路由',
  hostIndex.includes('ctx.effect(') && hostIndex.includes('webServer.register') && /kind:\s*['"]exact['"]/.test(hostIndex))
check('host 入口建工厂', hostIndex.includes('mountSideSessionFactory'))

const sideSession = read('sideSession.js')
// 代码路径（剥掉注释）：注释里会提到 fork / sessionPersistence 等名字
// 作为「为什么不能用」的说明，不能因此误判。
const sideSessionCode = sideSession
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// 旁路会话路必须走 agents.create，**不能**走 fork。三次报错的结论：
//   fork 不落盘 → 侧栏发送报 SessionPersistenceNotFoundError
//   自己补 persistence.create → resume 时 registerCreated 撞 writers，报 already exists
//   sessionPersistence 还被 isolate，第三方插件根本拿不到
// agents.create 内部 createStoredSession 会 persistence.create(header)，
// 一步完成「进 store + 落盘 + 拿 write 所有权」，没有冲突面。
check('旁路会话路必须用 agents.create', /agents\s*\.\s*create\s*\(/.test(sideSession))
check(
  '旁路会话路不许走 sessions.fork',
  !/\.fork\(/.test(sideSessionCode),
  'fork 不落盘，且与后续 resume 冲突',
)

// 两条路都必须用 agents.create —— 新 id 不在 store 里，不撞车；
// 而且只有它能让 meta.agentPreset 真正生效（复盘靠这个才只读）。
const freshBody = sideSessionCode.slice(sideSessionCode.indexOf('function createFreshSession'))

check(
  '新开会话路必须用 agents.create（只读预设才能生效）',
  freshBody !== '' && /agents\s*\.\s*create\s*\(/.test(freshBody),
)
check(
  '新开会话路把预设交给 create',
  /agentPreset/.test(freshBody) && /meta\s*:/.test(freshBody),
)
// seed 必须复刻官方 buildForkSeed：父会话前缀 + 一条 session/end-seed。
// 少了 end-seed，恢复出来的会话没有「继承到此为止」的边界。
check(
  '旁路会话路自建 seed（含 session/end-seed）',
  /session\/end-seed/.test(sideSessionCode) && /snapshotEvents/.test(sideSessionCode),
)
check(
  '旁路会话路不直接碰 sessionPersistence',
  !/sessionPersistence/.test(sideSessionCode),
  '该服务被 isolate，第三方插件拿不到',
)
check('工厂通过 subagents.queuePrompt 投递首条提问',
  sideSession.includes('firstMessage') && sideSession.includes('queuePrompt'))
check('工厂错误码齐全', ['parent-not-found', 'parent-not-live', 'create-failed']
  .every((c) => sideSession.includes(c)))

const rpc = read('sideAskRpc.js')
check('RPC confirm 门禁', rpc.includes('not-confirmed'))
check('RPC 回环防护', rpc.includes('forbidden') && rpc.includes('remoteAddress'))
// 注释里会提到 X-Forwarded-For（说明为什么不采信），所以只看代码路径：
// 不得出现对该头部的任何读取。
const rpcCode = rpc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check('RPC 不采信 X-Forwarded-For',
  !rpcCode.toLowerCase().includes('forwarded'),
  '代码中不得读取该头部')

const routeMatch = rpc.match(/ROUTE_PATH\s*=\s*['"]([^'"]+)['"]/)
check('路由常量有定义', routeMatch !== null, routeMatch?.[1])

// ── client 半 ─────────────────────────────────────────────────────────────
const client = read('client.js')
check('banner 协议', client.includes('window.__ModuleLoader__.load'))
check('banner id', client.includes('id: "dsh-selection-ask"'))
for (const k of [
  'mountSideAskTab', 'sideAskAddressFor', 'createSideAskClient',
  'ReviewEntry', 'side-ask.conversation',
  'conversation.session.header.utilities',
  // 复盘预设 id 现在归 host 侧（reviewSession.js），client 只负责调
  // openReviewSession，所以这里断言的是调用方法名而不是预设名。
  'openReviewSession',
]) {
  check(`client 含 ${k}`, client.includes(k))
}

// purity gate：除平台白名单外不得有裸 @deepseek-ai require
const PLATFORM = /^@deepseek-ai\/(cordis|dsh-client-store|dsh-client-ui-slots|dsh-client-ui-primitives|dsh-client-ui-dockkit|dsh-api-gateway|dsh-client-runtime)$/
const requires = [...client.matchAll(/require\("(@deepseek-ai\/[^"]+)"\)/g)].map((m) => m[1])
const illegal = [...new Set(requires)].filter((r) => !PLATFORM.test(r))
check('purity gate（无越狱值导入）', illegal.length === 0, illegal.join(', '))

// ── 会话日志能力（本轮新增） ─────────────────────────────────────────────
for (const f of ['sessionLog.js', 'sessionDigest.js', 'sessionLogLocate.js', 'reviewSession.js', 'sessionLogTool.js']) {
  check(`日志能力产物 ${f}`, existsSync(`${root}/lib/${f}`))
}

const sessionLog = read('sessionLog.js')
// 关键：多帧 zstd 必须自己切帧，不能只解第一帧。
// 实测一个真实日志有 1433 帧，单次解压只得到 223 字节且不报错。
check('逐帧解压实现', sessionLog.includes('findFrameStarts') || sessionLog.includes('zstd'))
check('坏帧容错并计数', sessionLog.includes('skipped'))
check('坏行计数', sessionLog.includes('badLines'))

const locate = read('sessionLogLocate.js')
// 目录名编码规则是 DSH 内部约定，自己复刻等于把版本耦合写死。
// 定位必须靠扫描 sessionId 目录，而不是计算目录名。
check('日志定位按会话 id 扫描（不复刻目录编码）',
  locate.includes('readdirSync') && !locate.includes('~4E2A'))

const digest = read('sessionDigest.js')
// token 口径：totalTokens 每步含完整上下文，累加会得到假数字（实测虚高百倍）。
check('token 口径用 outputTokens 累加', digest.includes('outputTokens'))
check('上下文规模取最新值而非累加', digest.includes('contextTokens'))
// 上下文组成（0.4.2 新增）：让「上下文膨胀」有可执行结论。
for (const f of ['systemPromptChars', 'toolSchemaChars', 'toolResultChars',
                 'userMessageChars', 'assistantMessageChars', 'injectedChars']) {
  check(`组成统计含 ${f}`, digest.includes(f))
}
check('组成渲染按占比降序', /sort\(/.test(digest) && digest.includes('totalChars'))
check('组成渲染指出最大头', digest.includes('最大头'))

const review = read('reviewSession.js')
check('复盘用只读预设', review.includes('session-review'))
check('复盘注入日志摘要', review.includes('renderDigest') || review.includes('digestText'))
check('复盘子会话不 fork（fork 会让只读预设失效）',
  !review.includes('.fork('))

// 6. 主题变量必须都在已发布的 token catalog 内。
// catalog 外的名字在出厂主题上解析不出值，曾导致图标/文字几乎不可见。
const CATALOG = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary', '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary', '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary', '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill',
])
// 只看真正参与渲染的 CSS：注释里会提到这些坏名字（作为「不要用」的警示），
// 不能因此误判。剥掉注释后再扫描。
const cssCode = client.replace(/\/\*[\s\S]*?\*\//g, '')
const usedTokens = [...new Set([...cssCode.matchAll(/(--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
const illegalTokens = usedTokens.filter((t) => !CATALOG.has(t))
check('主题变量都在 catalog 内', illegalTokens.length === 0, illegalTokens.join(', '))
check('CSS 中确实用到了主题变量', usedTokens.length > 0, `${usedTokens.length} 个`)

// 主按钮不能拿 brand-primary 当背景。DSH 的深色主题把 brand-primary 反转成
// 近白色（实测 #f9fafb），白底配浅色字完全看不见——「亮得看不到字」的根源。
// 主按钮必须用 bg-layer-2（背景）+ label-primary（文字），深浅主题都稳定。
const primaryRule = cssCode.match(/\.dsa-card-btn-primary\s*\{[^}]*\}/)
check('存在主按钮样式规则', primaryRule !== null)
if (primaryRule !== null) {
  check(
    '主按钮不用 brand-primary 当背景',
    !/background[^;]*brand-primary/.test(primaryRule[0]),
    '深色主题下 brand-primary 是近白色',
  )
  check(
    '主按钮用 bg-layer-2 做背景',
    /background[^;]*bg-layer-2/.test(primaryRule[0]),
  )
  check(
    '主按钮文字用 label-primary',
    /color[^;]*label-primary/.test(primaryRule[0]),
  )
}

// 未触碰官方 single 插槽（那会直接抛异常让插件加载失败）
check('不占用官方 sidebar.chat.conversation',
  !/slots\.register\(\s*\{\s*name:\s*['"]sidebar\.chat\.conversation['"]/.test(client))

// 两侧路由必须一致
check('两侧路由一致', routeMatch !== null && client.includes(routeMatch[1]), routeMatch?.[1])

console.log(`\n${problems.length === 0 ? '全部通过' : `失败 ${problems.length} 项：${problems.join('、')}`}`)
process.exit(problems.length === 0 ? 0 : 1)
