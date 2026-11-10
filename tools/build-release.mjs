#!/usr/bin/env node
// 打发布包：把当前工作副本复制成 <仓库>/dist/dsh-pisces，并把它改成可发布的 0.1.0。
//
// 口径（n74）：
// - 只带运行时需要的东西：index.js / client.js / lib / assets / cordis.patch.yml / README / LICENSE；
//   不带 test/、tools/、docs/、本机数据、persona-fixed.md。
// - lib/devkey.js 不进发布包；工具面/路由靠 package.json 的 dsh.pisces.release=true 关掉。
// - 可以重复跑：先清空 dist/dsh-pisces，再整体复制。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

const here = import.meta.dirname
const pkgRoot = resolve(here, '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const outRoot = join(repoRoot, 'dist', 'dsh-pisces')

// 复制清单：文件 + 目录；其它一律不带。
const FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'AGENTS.md', 'package.json']
const DIRS = ['lib', 'assets']
// 发布包里要删掉的文件（相对 outRoot）。
const DROP = ['lib/devkey.js', 'persona-fixed.md']

function fail(message) {
  console.error(`[build-release] 失败：${message}`)
  process.exit(1)
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (st.isFile()) out.push({ path: relative(outRoot, full).replace(/\\/g, '/'), size: st.size })
  }
  return out
}

// 0. 清空产物目录（只动 dist/dsh-pisces 这一个确定的路径）。
rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })

// 1. 文件
for (const name of FILES) {
  const src = join(pkgRoot, name)
  if (!existsSync(src)) fail(`缺 ${name}（${src}）`)
  cpSync(src, join(outRoot, name))
}
// LICENSE 在仓库根；如果将来包根也有一份，优先用包根的。
const licenseSrc = existsSync(join(pkgRoot, 'LICENSE'))
  ? join(pkgRoot, 'LICENSE')
  : join(repoRoot, 'LICENSE')
if (!existsSync(licenseSrc)) fail(`缺 LICENSE（找过 ${join(pkgRoot, 'LICENSE')} 和 ${join(repoRoot, 'LICENSE')}）`)
cpSync(licenseSrc, join(outRoot, 'LICENSE'))

// 2. 目录
for (const name of DIRS) {
  const src = join(pkgRoot, name)
  if (!existsSync(src)) fail(`缺目录 ${name}（${src}）`)
  cpSync(src, join(outRoot, name), { recursive: true })
}

// 3. 去掉发布包不该带的东西。
for (const rel of DROP) {
  const full = join(outRoot, rel)
  if (existsSync(full)) rmSync(full, { recursive: true, force: true })
}

// 4. 改 package.json：换名、去 private、打上 release 标记；version 沿用工作副本。
const pkgFile = join(outRoot, 'package.json')
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''))
} catch (e) {
  fail(`package.json 读不了：${e?.message || e}`)
}
pkg.name = 'dsh-pisces'
pkg.private = false
pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
pkg.dsh.pisces = { ...(pkg.dsh.pisces || {}), release: true }
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

// 4b. cordis.patch.yml 里的 name 必须跟包名一致，否则宿主按 name 解析不到模块、整条插件不激活
//（0.1.0 冒烟就是这么挂的：包名改成 dsh-pisces，patch 还写着 dsh-pisces-core）。
// id 保持 dsh-pisces-core（日志前缀、状态键都不变），只改 name。
const patchFile = join(outRoot, 'cordis.patch.yml')
if (!existsSync(patchFile)) fail(`缺 cordis.patch.yml（${patchFile}）`)
const patchText = readFileSync(patchFile, 'utf8').replace(/^(\s*name:\s*)dsh-pisces-core\s*$/m, '$1dsh-pisces')
if (!/^\s*name:\s*dsh-pisces\s*$/m.test(patchText)) fail('cordis.patch.yml 里没有改到 name: dsh-pisces')
writeFileSync(patchFile, patchText, 'utf8')

// 5. 自检：发布包里没有钥匙、有成年鱼样本、release 标记为 true。
if (existsSync(join(outRoot, 'lib', 'devkey.js'))) fail('lib/devkey.js 还在发布包里')
if (existsSync(join(outRoot, 'persona-fixed.md'))) fail('persona-fixed.md 不该进发布包')
if (!existsSync(join(outRoot, 'assets', 'adult-fish.soul.json'))) fail('缺 assets/adult-fish.soul.json')
if (pkg.dsh.pisces.release !== true) fail('package.json 的 dsh.pisces.release 不是 true')
if (JSON.stringify(pkg).includes('devkey')) fail('package.json 里不该出现 devkey')

// 6. 打印产物清单与总大小。
const manifest = walk(outRoot).sort((a, b) => a.path.localeCompare(b.path))
const total = manifest.reduce((n, x) => n + x.size, 0)
console.log(`[build-release] 发布包：${outRoot}`)
console.log(`[build-release] 版本：${pkg.version}  名字：${pkg.name}  release：true`)
for (const f of manifest) console.log(`  ${fmtSize(f.size).padStart(8)}  ${f.path}`)
console.log(`[build-release] 共 ${manifest.length} 个文件，合计 ${fmtSize(total)}`)


