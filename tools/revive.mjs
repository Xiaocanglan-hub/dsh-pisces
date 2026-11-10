#!/usr/bin/env node
// 复活：把一个 soul bundle 原样搬进一个新的数据目录。
//
// 口径（知识库 n19 / n29，别下次又猜）：
// 1. **先核清单，再动一个字节**：`readSoulBundle` 只读形状、`verifySoulBundle` 核四项指纹；
//    清单不过（ok:false）就直接返回 `{ok:false, reason:'清单对不上', problems}`，不建库、不写卡。
//    旧包的 diary.md 没 count 记进 legacy 放行（n29 的真 bug），其余项仍严格。
// 2. **dry 只核清单**：连 root 都不碰，所以可以在"还没有库"的目录上先演练一遍。
// 3. 导入本身交给 `importSoulBundle`（带 id 原样写、已有 id 跳过、日记 day != null 保住 day 0、
//    卡由 restoreCard 恢复成 0444）。
// 4. `revive()` **不关库**（调用方还要用）；CLI 关。返回值多带一个 `store` 就是给 CLI 关的。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'
import { readSoulBundle, verifySoulBundle, importSoulBundle } from '../lib/export.js'

const HERE = path.resolve(fileURLToPath(import.meta.url))
/** 被 import 时不许跑 CLI（测试要 import 这个模块）。只有直接 `node tools/revive.mjs` 才跑。 */
const invokedDirectly = () => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry).toLowerCase() === HERE.toLowerCase()
  } catch {
    return false
  }
}

const EMPTY_IMPORT = {
  imported: 0,
  skipped: 0,
  failed: 0,
  diary: null,
  card: null,
  chain: null,
  firstId: null,
  lastId: null,
}

const manifestOf = (verdict) => ({
  ok: Boolean(verdict?.ok),
  problems: Array.isArray(verdict?.problems) ? verdict.problems : [],
  legacy: Array.isArray(verdict?.legacy) ? verdict.legacy : [],
})

/**
 * 复活：核清单 → 建库 → 导入事件/日记/卡。
 * @param {{bundle:string, root:string, dry?:boolean, now?:number}} args
 * @returns {Promise<object>} `{ok, bundle, manifest:{ok,problems,legacy}, imported, skipped, failed,
 *   diary, card, chain, firstId, lastId}`；失败时另有 `reason`/`problems`；
 *   非 dry 成功时另有 `store`（调用方负责 close）。
 */
export async function revive({ bundle, root, dry = false, now = Date.now() } = {}) {
  const base = {
    ok: false,
    bundle: bundle == null ? null : String(bundle),
    manifest: { ok: false, problems: [], legacy: [] },
    ...EMPTY_IMPORT,
  }
  if (!bundle) return { ...base, reason: '没有 bundle', problems: ['没给 bundle 文件'] }

  let doc = null
  try {
    doc = readSoulBundle(bundle)
  } catch (e) {
    const why = String(e?.message || e)
    return { ...base, reason: '格式不对', problems: [why], manifest: { ok: false, problems: [why], legacy: [] } }
  }

  const manifest = manifestOf(verifySoulBundle(doc))
  const events = Array.isArray(doc.events) ? doc.events.length : 0

  // 清单不过：一个字节都不写。dry 也一样（不建库、不碰 root）。
  if (!manifest.ok) {
    return { ...base, manifest, events, reason: '清单对不上', problems: manifest.problems }
  }

  if (dry) {
    return { ...base, ok: true, dry: true, manifest, events }
  }

  if (!root) return { ...base, manifest, events, reason: '没有 root（数据目录）' }
  try {
    if (!fs.statSync(String(root)).isDirectory()) {
      return { ...base, manifest, events, reason: `root 不是目录：${root}` }
    }
  } catch {
    return { ...base, manifest, events, reason: `目录不存在：${root}` }
  }

  let store = null
  try {
    store = await createStore({ root, log: (m) => console.error(m) })
  } catch (e) {
    return { ...base, manifest, events, reason: `建库失败：${String(e?.message || e)}` }
  }

  let res = null
  try {
    res = await importSoulBundle({ file: bundle, store, root, now: Number(now) || Date.now() })
  } catch (e) {
    try {
      store.close()
    } catch {}
    return { ...base, manifest, events, reason: `导入失败：${String(e?.message || e)}` }
  }

  const out = {
    ok: Boolean(res.ok),
    bundle: String(bundle),
    manifest,
    imported: res.imported,
    skipped: res.skipped,
    failed: res.failed,
    diary: res.diary,
    card: res.card,
    chain: res.chain,
    firstId: res.firstId,
    lastId: res.lastId,
    events,
    store,
  }
  if (!res.ok) {
    out.reason = res.reason || '导入没通过'
    out.problems = Array.isArray(res.problems) ? res.problems : []
    if (Array.isArray(res.samples) && res.samples.length) out.samples = res.samples
  }
  return out
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { bundle: null, root: null, dry: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i])
    if (a === '--dry') args.dry = true
    else if (a === '--bundle' || a === '--root') {
      const v = argv[i + 1]
      if (v == null || String(v).startsWith('--')) throw new Error(`${a} 后面要跟一个值`)
      args[a.slice(2)] = String(v)
      i += 1
    } else if (a.startsWith('--bundle=')) args.bundle = a.slice(9)
    else if (a.startsWith('--root=')) args.root = a.slice(7)
    else throw new Error(`认不得的参数：${a}`)
  }
  return args
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: String(e?.message || e), manifest: { ok: false, problems: [], legacy: [] } }))
    process.exitCode = 1
    return
  }
  if (!args.bundle || !args.root) {
    console.log(JSON.stringify({ ok: false, reason: '用法：node tools/revive.mjs --bundle <soul.json> --root <数据目录> [--dry]' }))
    process.exitCode = 1
    return
  }

  const out = await revive({ bundle: args.bundle, root: args.root, dry: args.dry })
  const store = out.store || null
  try {
    store?.close()
  } catch {}
  const { store: _drop, ...summary } = out
  console.log(JSON.stringify(summary))
  if (!out.ok) process.exitCode = 1
}

if (invokedDirectly()) {
  main().catch((e) => {
    console.log(JSON.stringify({ ok: false, reason: `复活失败：${String(e?.message || e)}`, manifest: { ok: false, problems: [], legacy: [] } }))
    process.exitCode = 1
  })
}
