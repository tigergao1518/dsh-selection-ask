// 校验 persona 配置：YAML 能解析 + 所有 persona 的 prefix/suffix 不含模板变量。
//
// 默认扫 profile 的 cordis.patch.yml；从第三个参数起可再传若干 preset 源文件
// （例如仓库里的 docs/session-review-preset.yml），它们最终会被 insert 进补丁层，
// 所以必须和补丁层受同一套检查保护。
//
// 路径不写死：DSH_HOME 优先，否则回落到用户主目录下的 .dsh，
// profile 名可用第一个参数覆盖（默认 desktop）。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const profile = process.argv[2]?.trim() || 'desktop'
const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
// 额外扫描的 preset 源文件（相对路径按当前工作目录解析）
const extraPaths = process.argv.slice(3).map((p) => resolve(p))
const scanPaths = [patchPath, ...extraPaths]

// 试拿 profile 里的 js-yaml（DSH 的补丁层用自定义 !!js 标签，
// 通用 yaml 解析器不认，会误报）。
let YAML
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(join(dshHome, 'profiles', 'package.json'))
  YAML = require('js-yaml')
} catch {
  YAML = undefined
}

if (YAML === undefined) {
  // 拿不到 js-yaml 就退化为纯文本检查：只扫非注释行有没有 {{ 变量。
  // 这个退化仍然能抓住「persona 里写了无法解析的模板变量」这类问题。
  console.log('（未拿到 js-yaml，退化为纯文本检查）')
  const bad = []
  for (const p of scanPaths) {
    const lines = readFileSync(p, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith('#')) continue
      if (/\{\{/.test(line)) bad.push(`${p} L${i + 1}: ${line.slice(0, 80)}`)
    }
  }
  console.log(bad.length === 0 ? '通过：非注释行无 {{ 变量' : `失败：${bad.join('; ')}`)
  process.exit(bad.length === 0 ? 0 : 1)
}

// DSH 的补丁层用自定义 `!!js` 标签承载表达式（如 process.platform 判断）。
// 按同样语义注册：把标量当 JS 源码求值。
const JS_SCHEMA = YAML.DEFAULT_SCHEMA.extend([
  new YAML.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({
      __js: true,
      source: data,
      evaluate: () => (0, eval)(data),
    }),
  }),
])

let personas = 0
const bad = []
function walk(node) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n); return }
  if (node.name === '@deepseek-ai/dsh-persona' && node.config !== undefined) {
    personas++
    // prefix / suffix 是 preset 与补丁层的常规字段；text 是另一种写法
    // （整段人格文本），同样会走变量插值，漏掉它就会漏报。
    for (const k of ['prefix', 'suffix', 'text']) {
      const v = node.config[k]
      if (typeof v !== 'string') continue
      const m = v.match(/\{\{[^}]+\}\}/g)
      if (m !== null) bad.push(`${k} 含 ${m.join(',')}`)
    }
  }
  for (const k of Object.keys(node)) walk(node[k])
}

for (const p of scanPaths) {
  const src = readFileSync(p, 'utf8')
  // js-yaml 用 load + schema；解析失败是抛异常，不是返回 errors 数组。
  let root
  try {
    root = YAML.load(src, { schema: JS_SCHEMA })
  } catch (error) {
    console.error(`YAML 解析失败 (${p}):`, error.message)
    process.exit(1)
  }
  console.log(`YAML 解析通过: ${p}`)
  walk(root ?? [])
}

console.log(`共检查 ${personas} 个 persona`)
if (bad.length > 0) {
  console.log('失败：' + bad.join('; '))
  process.exit(1)
}
console.log('通过：所有 persona 的 prefix/suffix 均不含模板变量')
