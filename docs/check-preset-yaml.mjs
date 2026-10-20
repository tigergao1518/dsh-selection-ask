// 用 profile 自带的 js-yaml 解析 desktop cordis.patch.yml，验证复盘预设插入后
// 整个补丁层仍是合法 YAML，且 preset-session-review 条目结构符合预期。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// 路径不写死：DSH_HOME 优先，否则回落到用户主目录下的 .dsh，
// 这样脚本在别的机器上也能跑。
const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')

const require = createRequire(join(profilesRoot, 'package.json'))
const YAML = require('js-yaml')

// DSH 的补丁层用自定义 `!!js` 标签承载表达式（如 process.platform 判断）。
// js-yaml 把这个简写解析成完整 URI `tag:yaml.org,2002:js`，默认不认，
// 这里按同样语义注册：把标量当 JS 源码求值。
const JS_SCHEMA = YAML.DEFAULT_SCHEMA.extend([
  new YAML.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({
      __js: true,
      source: data,
      // 仅供本校验脚本读取布尔语义，不参与 DSH 运行。
      evaluate: () => (0, eval)(data),
    }),
  }),
])

// profile 名可用第一个参数覆盖，默认 desktop（本仓库只维护 desktop profile）。
const profile = process.argv[2]?.trim() || 'desktop'
const path = join(profilesRoot, profile, 'cordis.patch.yml')
const text = readFileSync(path, 'utf8')

let doc
try {
  doc = YAML.load(text, { schema: JS_SCHEMA })
} catch (error) {
  console.error('YAML 解析失败:', error.message)
  process.exit(1)
}

if (!Array.isArray(doc)) {
  console.error('补丁层不是数组，类型是:', typeof doc)
  process.exit(1)
}
console.log('补丁层解析成功，顶层条目数:', doc.length)

const inserts = doc.filter((entry) => entry && typeof entry === 'object' && 'insert' in entry)
console.log('insert 块数量:', inserts.length)

const ids = []
for (const block of inserts) {
  for (const row of block.insert ?? []) {
    if (row && typeof row === 'object' && typeof row.id === 'string') ids.push(row.id)
  }
}
console.log('insert 条目 id 清单:')
for (const id of ids) console.log('  -', id)

const preset = inserts
  .flatMap((block) => block.insert ?? [])
  .find((row) => row && row.id === 'preset-session-review')

if (preset === undefined) {
  console.error('未找到 preset-session-review 条目')
  process.exit(1)
}

const config = preset.config ?? {}
console.log('\n=== preset-session-review ===')
console.log('name 字段   :', preset.name)
console.log('preset id   :', config.id)
console.log('显示名      :', config.name)
console.log('order       :', config.order)
console.log('plugins 数  :', Array.isArray(config.plugins) ? config.plugins.length : '(缺失)')

const pluginIds = (config.plugins ?? []).map((p) => `${p.id} (${p.name})`)
console.log('插件清单:')
for (const p of pluginIds) console.log('  -', p)

// 关键断言：复盘预设绝不能带写与执行能力
const forbidden = ['tool-bash', 'tool-pwsh', 'tool-fs-write', 'planning', 'delegation', 'skill-filesystem', 'command-goal', 'tool-goal']
const declared = new Set((config.plugins ?? []).map((p) => p.id))
const leaked = forbidden.filter((id) => declared.has(id))
console.log('\n写/执行能力泄漏检查:', leaked.length === 0 ? '通过（无泄漏）' : `失败 -> ${leaked.join(', ')}`)

// 关键断言：必须保留 rewind 与只读检索
const required = ['tool-fs', 'tool-fs-search', 'tool-web', 'rewind']
const missing = required.filter((id) => !declared.has(id))
console.log('必需能力检查    :', missing.length === 0 ? '通过（齐全）' : `失败 -> 缺少 ${missing.join(', ')}`)

const persona = (config.plugins ?? []).find((p) => p.id === 'persona')
console.log('persona prefix  :', persona?.config?.prefix ? '已设置' : '缺失')

if (leaked.length > 0 || missing.length > 0 || !persona?.config?.prefix) {
  console.error('\n断言失败')
  process.exit(1)
}
console.log('\n全部断言通过')
