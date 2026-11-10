#!/usr/bin/env node
// 从事件流重建人设卡：`card_patch`（只认 decision==='applied'）里最后一条 self、
// 每个 target 最后一条 bond，写回 card/self.md、card/bonds/<slug>.json、identity.json。
//
// 口径（知识库 n29 / n34，别下次又猜）：
// 1. **没有 applied 的 card_patch 就什么都不建**：返回 `{ok:true, wrote:0}`，不留空卡
//    （空 self.md 会让"冷启动基线"和真实性都说不清）。
// 2. **正文文件 0444，state.json 必须可写**：`writeProjection` 要重写 state；
//    state 若被锁成只读，Windows 上写入/rename 会 EPERM（n34 实测）。这里写 state 前先 chmod 0666。
// 3. **摘要/备份一起回填**：只写文件不更新 state.digests，下次 `tamperCheck` 会拿旧备份
//    把刚重建的卡"改回去"。所以每写一个文件就同步 digests/backup，并把今天基线 reset 到重建后的样子。
// 4. 事件按流里的先后取"最后一条"（readAll 的 seq 顺序），不按 ts 重排：重建读的是"她最后写下的样子"。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cardPaths, slugify, SELF_HEADER, selfBody, writeProjection, ZERO_STATE } from '../lib/card.js'
import { createStore } from '../lib/store.js'
import { dayOf, sha256 } from '../lib/util.js'

const HERE = path.resolve(fileURLToPath(import.meta.url))
/** 被 import 时不许跑 CLI（测试要 import 这个模块）。只有直接 `node tools/rebuild-card.mjs` 才跑。 */
const invokedDirectly = () => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry).toLowerCase() === HERE.toLowerCase()
  } catch {
    return false
  }
}

const exists = (p) => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null
  } catch {
    return null
  }
}

function readState(root) {
  const j = readJson(cardPaths(root).state)
  if (!j) return null
  return {
    ...ZERO_STATE(),
    ...j,
    digests: { ...(j.digests || {}) },
    backup: { ...(j.backup || {}) },
    lastPatch: { ...(j.lastPatch || {}) },
  }
}

/** state.json 不设只读：写之前先解锁（Windows 上 0444 就是只读属性）。 */
function writeState(root, state) {
  const p = cardPaths(root)
  fs.mkdirSync(p.dir, { recursive: true })
  try {
    fs.chmodSync(p.state, 0o666)
  } catch {}
  fs.writeFileSync(p.state, `${JSON.stringify(state, null, 2)}\n`)
}

/** 正文文件：先解锁再写，写完锁回 0444。 */
function writeReadonly(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.chmodSync(file, 0o666)
  } catch {}
  fs.writeFileSync(file, String(text))
  try {
    fs.chmodSync(file, 0o444)
  } catch {}
}

const charsOf = (text) => [...String(text ?? '')].length

/**
 * 从事件流重建卡。
 * @param {{root:string, store:object, now?:number, dry?:boolean}} args
 * @returns {{ok:boolean, wrote:number, self:{rev:number,chars:number}|null,
 *   bonds:Array<{name:string,rev:number,chars:number}>, identity:object|null}}
 *   wrote 只数卡正文文件（self.md + bonds/*.json），不含系统写的 state.json / identity.json。
 */
export function rebuildCardFromEvents({ root, store, now = Date.now(), dry = false } = {}) {
  const ts = Number(now) || Date.now()
  const empty = { ok: true, wrote: 0, self: null, bonds: [], identity: null }
  if (!root) return { ...empty, ok: false, reason: '没有 root' }

  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }

  const applied = events.filter((e) => String(e?.type || '') === 'card_patch' && e?.meta?.decision === 'applied')
  if (!applied.length) return empty // 没有任何可用的 card_patch：不建空卡

  let selfEvent = null
  const bondEvents = new Map()
  for (const e of applied) {
    const kind = String(e?.meta?.kind || '')
    if (kind === 'self') {
      selfEvent = e
    } else if (kind === 'bond') {
      const raw = String(e?.meta?.target ?? '').trim()
      if (!raw) continue // 老事件没写 target：认不出是谁，跳过而不是写成 unknown.json
      bondEvents.set(slugify(raw), e) // 同一个人的后一条覆盖值，位置仍是第一次出现的顺序
    }
  }

  const selfText = selfEvent == null ? null : String(selfEvent.text ?? '')
  const selfRev = Number(selfEvent?.meta?.rev) || 0
  const bonds = [...bondEvents.entries()]
    .map(([name, e]) => ({ name, rev: Number(e?.meta?.rev) || 0, chars: charsOf(e?.text), text: String(e?.text ?? ''), at: Number(e?.ts) || ts }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const summary = {
    self: selfText == null ? null : { rev: selfRev, chars: charsOf(selfText) },
    bonds: bonds.map(({ name, rev, chars }) => ({ name, rev, chars })),
  }

  if (dry) return { ok: true, wrote: 0, ...summary, identity: null }

  const p = cardPaths(root)
  fs.mkdirSync(p.bondsDir, { recursive: true })

  const state = readState(root) || ZERO_STATE(ts)
  let rev = Number(state.rev) || 0
  const record = (rel, text) => {
    state.digests[rel] = sha256(text)
    state.backup[rel] = text
  }

  let wrote = 0
  let selfBodyText = ''
  if (selfText != null) {
    selfBodyText = selfBody(selfText).trim()
    const fileText = `${SELF_HEADER}\n\n${selfBodyText}\n`
    writeReadonly(p.self, fileText)
    record('self.md', fileText)
    rev = Math.max(rev, selfRev)
    wrote += 1
  } else {
    // 只有 bond：self.md 原样不动（没有就不建）。
    selfBodyText = selfBody(exists(p.self) ? fs.readFileSync(p.self, 'utf8') : '').trim()
  }

  for (const b of bonds) {
    const fileText = `${JSON.stringify({ slug: b.name, text: b.text, rev: b.rev, at: b.at || ts }, null, 2)}\n`
    writeReadonly(path.join(p.bondsDir, `${b.name}.json`), fileText)
    record(`bonds/${b.name}.json`, fileText)
    rev = Math.max(rev, b.rev)
    wrote += 1
  }

  state.rev = rev
  state.updatedAt = ts
  // 今天基线 reset 到重建后的样子：否则重建完第一次正经改卡会被漂移闸（35%）挡住。
  state.dayBase = { day: dayOf(ts), self: selfBodyText, bonds: Object.fromEntries(bonds.map((b) => [b.name, b.text])) }
  writeState(root, state)

  const identity = writeProjection(root, { store, now: ts })
  return { ok: true, wrote, ...summary, identity }
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { root: null, dry: false }
  for (const a of argv) {
    if (a === '--dry') args.dry = true
    else if (a.startsWith('--')) throw new Error(`认不得的参数：${a}`)
    else if (!args.root) args.root = a
    else throw new Error(`多给了一个参数：${a}`)
  }
  return args
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(JSON.stringify({ ok: false, reason: String(e?.message || e) }))
    process.exitCode = 1
    return
  }
  if (!args.root) {
    console.error('用法：node tools/rebuild-card.mjs <root> [--dry]')
    process.exitCode = 1
    return
  }
  const root = path.resolve(args.root)
  if (!exists(root)) {
    console.log(JSON.stringify({ ok: false, reason: `目录不存在：${root}`, wrote: 0 }))
    process.exitCode = 1
    return
  }

  // 没有事件库就别 createStore：那会在空目录里建出三本空库。
  // 有哪个库就读哪个：sqlite 优先，只有 jsonl 时强制 jsonl（否则会新建一个空的 events.db 读不到东西）。
  const data = path.join(root, 'events.db')
  const jsonl = path.join(root, 'events.jsonl')
  const hasSqlite = exists(data)
  const hasJsonl = exists(jsonl)
  if (!hasSqlite && !hasJsonl) {
    console.log(JSON.stringify({ ok: true, wrote: 0, self: null, bonds: [], identity: null, reason: '没有事件库' }))
    return
  }

  let store = null
  try {
    store = await createStore({ root, forceJsonl: !hasSqlite && hasJsonl, log: (m) => console.error(m) })
    const out = rebuildCardFromEvents({ root, store, dry: args.dry })
    const oneLine = {
      ok: Boolean(out.ok),
      wrote: out.wrote,
      self: out.self,
      bonds: out.bonds,
      identity: out.identity ? { rev: out.identity.rev, day: out.identity.day, mode: out.identity.mode } : null,
    }
    if (out.reason) oneLine.reason = out.reason
    console.log(JSON.stringify(oneLine))
    if (!out.ok) process.exitCode = 1
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: String(e?.message || e) }))
    process.exitCode = 1
  } finally {
    try {
      store?.close()
    } catch {}
  }
}

if (invokedDirectly()) {
  main().catch((e) => {
    console.error(`重建失败：${e?.message || e}`)
    process.exitCode = 1
  })
}
