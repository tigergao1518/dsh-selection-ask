// 校验 dsh-selection-ask 的 package.json 是合法 JSON 且无 BOM，
// 并核对 0.3.0 的关键字段（exports、dsh.client、版本号）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 插件目录可用第一个参数覆盖，默认仓库内的 dsh-selection-ask。
// 该目录按仓库惯例被 gitignore（第三方插件的本地副本，单独管理），
// 所以这里从仓库根拼路径，而不是把它当作受版本控制的源码。
const root = process.argv[2]?.trim() || join(process.cwd(), 'dsh-selection-ask')
const path = join(root, 'package.json')
const buf = readFileSync(path)
const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
console.log('含 BOM:', bom, '（必须为 false）')

const pkg = JSON.parse(buf.toString('utf8'))
console.log('版本    :', pkg.version)
console.log('main    :', pkg.main)
console.log('client  :', pkg.exports['./client']?.default)
console.log('描述    :', pkg.description)
console.log('平台    :', pkg.dsh?.client?.platform)
console.log('bundles :', JSON.stringify(pkg.dsh?.bundle))

if (bom) {
  console.error('失败：package.json 带 BOM')
  process.exit(1)
}
// 版本 0.3.1 修掉两个 0.3.0 的实测问题：
//   (a) fork 未显式指定子会话 id，撞上磁盘已存在的 session-N；
//   (b) 复盘按钮用了 catalog 外的主题变量，浅色主题下几乎看不见。
// 这里只断言「至少 0.3.x」，免得每次小版本升级都要改脚本。
const [major, minor] = pkg.version.split('.').map(Number)
if (!(major > 0 || (major === 0 && minor >= 3))) {
  console.error(`失败：版本号 ${pkg.version} 低于要求的 0.3.x`)
  process.exit(1)
}
if (pkg.dsh?.client?.platform !== 'web') {
  console.error('失败：client platform 不是 web')
  process.exit(1)
}
console.log('\npackage.json 校验通过')
