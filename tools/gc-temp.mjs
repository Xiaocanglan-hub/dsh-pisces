#!/usr/bin/env node
// 清理测试夹具：%TEMP% 里 pisces-* 的临时目录（每次跑测试 mkdtemp 一个，从不回收）。
//
// 口径：
// - 默认只 "看"（dry-run），打印数量/体积/最老最新的时间，不删任何东西。
// - `--apply` 才真删；`--hours N`（默认 12）只删最后修改早于 N 小时的，保护正在跑的测试。
// - 只认 pisces- 前缀，别的一律不碰。
//
// 用法：
//   node tools/gc-temp.mjs                 # 看一眼
//   node tools/gc-temp.mjs --apply         # 删 12 小时前的
//   node tools/gc-temp.mjs --apply --hours 1
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const hoursArg = args.indexOf('--hours')
const hours = hoursArg >= 0 ? Number(args[hoursArg + 1]) || 12 : 12
const dirArg = args.indexOf('--dir')
const PREFIX = 'pisces-'
// 注意：DSH 会话里 os.tmpdir() 会被指到会话临时目录（TEMP=...\dsh-xxx），
// 那里面只有本会话的少量夹具；真正堆了 4 万个的是用户的 Temp。所以这里显式取真实 Temp。
const TMP = dirArg >= 0
  ? path.resolve(args[dirArg + 1])
  : process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp')
    : path.join(os.homedir(), 'AppData', 'Local', 'Temp')
const cutoff = Date.now() - hours * 3600_000

function dirSize(p) {
  let bytes = 0
  let files = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop()
    let ents
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(full)
      else {
        try {
          bytes += fs.statSync(full).size
          files++
        } catch {}
      }
    }
  }
  return { bytes, files }
}

let names = []
try {
  names = fs.readdirSync(TMP).filter((n) => n.startsWith(PREFIX))
} catch (e) {
  console.error(`读不了 ${TMP}：${e?.message || e}`)
  process.exitCode = 1
}

const doomed = []
let skipped = 0
for (const name of names) {
  const p = path.join(TMP, name)
  let st
  try {
    st = fs.statSync(p)
  } catch {
    continue
  }
  if (!st.isDirectory()) continue
  if (st.mtimeMs > cutoff) {
    skipped++
    continue
  }
  doomed.push({ name, p, mtime: st.mtimeMs })
}

let totalBytes = 0
let totalFiles = 0
const t0 = Date.now()
for (const d of doomed) {
  const s = dirSize(d.p)
  d.bytes = s.bytes
  d.files = s.files
  totalBytes += s.bytes
  totalFiles += s.files
}

const oldest = doomed.length ? doomed.reduce((a, b) => (a.mtime < b.mtime ? a : b)) : null
const newest = doomed.length ? doomed.reduce((a, b) => (a.mtime > b.mtime ? a : b)) : null
const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

console.log(`临时目录：${TMP}`)
console.log(`匹配 ${PREFIX}*：${names.length} 个；其中早于 ${hours} 小时：${doomed.length} 个（跳过新的 ${skipped} 个）`)
console.log(`合计：${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${totalFiles} 个文件`)
if (oldest) console.log(`最老：${oldest.name}（${day(oldest.mtime)}）；最新命中：${newest.name}（${day(newest.mtime)}）`)
console.log(`统计耗时：${((Date.now() - t0) / 1000).toFixed(1)} 秒`)

if (!apply) {
  console.log('\n[dry-run] 什么都没删。要删就加 --apply。')
  process.exit(0)
}

let removed = 0
let failed = 0
for (const d of doomed) {
  try {
    fs.rmSync(d.p, { recursive: true, force: true })
    removed++
  } catch {
    failed++
  }
}
console.log(`\n已删 ${removed} 个${failed ? `；删不掉（可能被占用）${failed} 个` : ''}`)
