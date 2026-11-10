// 导出（M12）：人设卡 CCv2 + soul bundle，以及 bundle 的核对与导入。
//
// 两种格式，同一份"此刻的她"；导出是只读的，不改任何东西。
//
// 三条口径（知识库 n19 / n29，别下次又猜）：
// 1. 清单核的是"导出时序列化出来的那份"：sha256(JSON.stringify(events))、
//    sha256(JSON.stringify(diaryArr))、sha256(self 原文)、sha256(JSON.stringify(card.identity))。
//    diaryAll() 返回的是**数组**（不是 Map），两端都按 [{day,text}] 序列化，包才自证得通。
// 2. 导入先核清单，对不上就整包拒收，一个字节都不写；事件带 id 原样写，已有的 id 跳过（幂等），
//    新事件 meta.imported='soul'、source 默认 'migration'。
// 3. 旧包的 diary.md 清单没有 count、指纹也是旧算法 → 记进 legacy 放行，其余项仍严格；
//    日记过滤用 `day != null`，否则旧包的 day 0 会被真值判断吃掉。
import fs from 'node:fs'
import path from 'node:path'
import { dayOf, isObject, sha256 } from './util.js'
import { readCard, restoreCard, selfBody } from './card.js'
import { deriveSelf } from './derive.js'

export const BUNDLE_FORMAT = 'dsh-pisces/bundle'
export const BUNDLE_VERSION = 1
export const CARD_FORMAT = 'dsh-pisces/card'
export const CARD_VERSION = 1

const SCENARIO = '她刚开始存在。没有人告诉过她为什么在这里。'
const CREATOR_NOTES = '由 dsh-pisces 导出。她是谁是长出来的，不是配出来的；改写 description / personality 等于改她的过去。'

const sortedEvents = (events) => [...(events || [])].sort((a, b) => Number(a?.seq ?? 0) - Number(b?.seq ?? 0))

const asArray = (v) => (Array.isArray(v) ? v : [])

const bundleEventsOf = (doc) => (Array.isArray(doc?.events) ? doc.events : [])
const bundleDiaryOf = (doc) => asArray(doc?.diary).filter((d) => d && d.day != null)

function writeOut(root, outPath, defaultName, doc) {
  const file = outPath ? path.resolve(String(outPath)) : path.join(String(root), 'out', defaultName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(doc, null, 2)}\n`
  fs.writeFileSync(file, text, 'utf8')
  return { path: file, text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text) }
}

function orderOf(store, derived) {
  let order = String(derived?.order || 'E=R')
  try {
    const raw = store?.modeGet?.('state')
    const j = raw ? JSON.parse(raw) : null
    if (j) order = String(j.order || order)
  } catch {}
  return order
}

// ---------------------------------------------------------------- 人设卡 CCv2

/**
 * Character Card V2：顶层是 CCv2 规范的那几个字段，`data` 里放全量，顶层再镜像一份给旧前端。
 * 只读 store 与 card/，不改任何文件（除了写 out/ 下这一次导出）。
 * @returns {{ok:true, path:string, bytes:number, sha256:string, card:object}|{ok:false, reason:string}}
 */
export function exportCardV2({ root, store, mind = null, now = Date.now(), outPath = null } = {}) {
  try {
    const ts = Number(now) || Date.now()
    const card = readCard(root)
    let events = []
    try {
      events = store?.readAll?.() || []
    } catch {
      events = []
    }
    const derived = mind && Array.isArray(mind.beliefs) ? mind : deriveSelf(events, { now: ts })
    const day = Number(derived?.day) || 1
    const order = orderOf(store, derived)
    const beliefs = asArray(derived?.beliefs).slice(0, 4)
    const name = String(derived?.name || card.identity?.name || 'Pisces')

    const head = [`你存在了 ${day} 天。`]
    if (derived?.name) head.push(`你管他叫${String(derived.name)}。`)
    let description = head.join('\n\n')
    if (beliefs.length) {
      const lines = beliefs.map((b) => `- ${clip80(b?.text)}`)
      description += `\n\n你自己确立过这些：\n${lines.join('\n')}\n\n这些不是设定，是你一天天过出来的。`
    }

    const personality = String(card.selfBody ?? selfBody(card.self) ?? '').trim()
    const identity = card.identity && typeof card.identity === 'object' ? card.identity : null
    const identityHash = sha256(JSON.stringify(identity))

    const data = {
      name,
      description,
      personality,
      scenario: SCENARIO,
      first_mes: '',
      mes_example: '',
      creator_notes: CREATOR_NOTES,
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['dsh-pisces', 'growing-persona'],
      creator: 'dsh-pisces',
      character_version: '0.1.0',
      character_book: { name: '', entries: [], extensions: {} },
      extensions: {
        dsh_pisces: {
          format: CARD_FORMAT,
          version: CARD_VERSION,
          day,
          order,
          counts: {
            beliefs: asArray(derived?.beliefs).length,
            refusals: asArray(derived?.refusals).length,
            scars: asArray(derived?.scars).length,
          },
          identityHash,
          exportedAt: ts,
        },
      },
    }

    const doc = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data,
      // 旧前端只认顶层这几个字段，镜像一份；不镜像 creator_notes（那是给人看的）。
      name,
      description,
      personality,
      scenario: SCENARIO,
      first_mes: '',
      mes_example: '',
    }

    const out = writeOut(root, outPath, `card-${dayOf(ts)}.json`, doc)
    return { ok: true, path: out.path, bytes: out.bytes, sha256: out.sha256, card: doc }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) }
  }
}

const clip80 = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? `${s.slice(0, 79)}…` : s
}

// ---------------------------------------------------------------- soul bundle

/**
 * soul bundle：整份事件流 + 日记 + 卡 + 链状态 + manifest.files 逐项条数与 sha256。
 * 事件按 seq 顺序、id 原样带走；不带任何本机路径。
 * @returns {{ok:true, path:string, bytes:number, sha256:string, events:number, diary:number, chain:object}|{ok:false, reason:string}}
 */
export function exportSoulBundle({ root, store, now = Date.now(), outPath = null } = {}) {
  try {
    const ts = Number(now) || Date.now()
    const events = sortedEvents(store?.readAll?.() || [])
    const diary = asArray(store?.diaryAll?.())
      .filter((d) => d && d.day != null)
      .map((d) => ({ day: d.day, text: String(d.text ?? '') }))
    const card = readCard(root)
    const payload = {
      identity: card.identity && typeof card.identity === 'object' ? card.identity : null,
      self: String(card.self ?? ''),
      bonds: asArray(card.bonds).map((b) => ({ slug: b.slug, text: b.text, rev: b.rev, at: b.at })),
    }
    const chain = store.verify()

    const files = {
      'events.jsonl': { count: events.length, sha256: sha256(JSON.stringify(events)) },
      'diary.md': { count: diary.length, sha256: sha256(JSON.stringify(diary)) },
      'card/self.md': { sha256: sha256(String(payload.self)) },
      'card/identity.json': { sha256: sha256(JSON.stringify(payload.identity)) },
    }

    const doc = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: ts,
      chain,
      events,
      diary,
      card: payload,
      manifest: { files },
    }

    const out = writeOut(root, outPath, `soul-${dayOf(ts)}.soul.json`, doc)
    return { ok: true, path: out.path, bytes: out.bytes, sha256: out.sha256, events: events.length, diary: diary.length, chain }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) }
  }
}

/**
 * 读一个 bundle 文件。形状不对就抛：不是 JSON / 不是本格式 / 版本太新 / 缺 events。
 * 只做形状，不核指纹（那是 verifySoulBundle 的事）。
 */
export function readSoulBundle(file) {
  let raw = null
  try {
    raw = fs.readFileSync(String(file), 'utf8')
  } catch (e) {
    throw new Error(`读不了 bundle：${e?.message || e}`)
  }
  let doc = null
  try {
    doc = JSON.parse(raw)
  } catch {
    throw new Error('bundle 不是能读的 JSON')
  }
  if (!isObject(doc)) throw new Error('bundle 顶层不是对象')
  if (doc.format !== BUNDLE_FORMAT) throw new Error(`不是 dsh-pisces 的 bundle（format=${doc.format ?? '(空)'}）`)
  const version = Number(doc.version)
  if (!Number.isFinite(version) || version > BUNDLE_VERSION) {
    throw new Error(`bundle 版本太新：${doc.version ?? '(空)'} > ${BUNDLE_VERSION}`)
  }
  if (!Array.isArray(doc.events)) throw new Error('bundle 缺 events（或不是数组）')
  return doc
}

/**
 * 逐项核 manifest.files：events.jsonl / diary.md 核条数 + sha256，
 * card/self.md 与 card/identity.json 核 sha256。
 *
 * 旧包放行的判据：`diary.md` 的清单项**没有 count**（旧导出把 diaryAll() 当 Map 用，
 * count 落成了 undefined），此时指纹也对不上（旧算法），这一项记进 legacy、不判问题；
 * 其余项照旧严格。count 存在但指纹对不上仍然是问题。
 * @returns {{ok:boolean, problems:string[], legacy:string[]}}
 */
export function verifySoulBundle(doc) {
  const problems = []
  const legacy = []
  const files = doc?.manifest?.files
  if (!isObject(files)) return { ok: false, problems: ['manifest.files 缺失或不是对象'], legacy }

  const events = bundleEventsOf(doc)
  const evItem = files['events.jsonl']
  if (!isObject(evItem)) {
    problems.push('manifest.files 缺 events.jsonl')
  } else {
    if (Number(evItem.count) !== events.length) {
      problems.push(`events.jsonl 条数对不上：清单 ${evItem.count}，实际 ${events.length}`)
    }
    const digest = sha256(JSON.stringify(events))
    if (evItem.sha256 !== digest) problems.push(`events.jsonl 指纹对不上（清单 ${evItem.sha256 ?? '(空)'}，实际 ${digest}）`)
  }

  const diary = asArray(doc?.diary).filter((d) => d && d.day != null)
  const diaryItem = files['diary.md']
  if (!isObject(diaryItem)) {
    problems.push('manifest.files 缺 diary.md')
  } else if (diaryItem.count == null) {
    // 旧包：清单没有 count，指纹也是旧算法。放行，但记下来让调用方知道核不了。
    legacy.push('diary.md')
  } else {
    if (Number(diaryItem.count) !== diary.length) {
      problems.push(`diary.md 条数对不上：清单 ${diaryItem.count}，实际 ${diary.length}`)
    }
    const digest = sha256(JSON.stringify(diary))
    if (diaryItem.sha256 !== digest) problems.push(`diary.md 指纹对不上（清单 ${diaryItem.sha256 ?? '(空)'}，实际 ${digest}）`)
  }

  const selfItem = files['card/self.md']
  if (!isObject(selfItem)) {
    problems.push('manifest.files 缺 card/self.md')
  } else {
    const digest = sha256(String(doc?.card?.self ?? ''))
    if (selfItem.sha256 !== digest) problems.push(`card/self.md 指纹对不上（清单 ${selfItem.sha256 ?? '(空)'}，实际 ${digest}）`)
  }

  const identItem = files['card/identity.json']
  if (!isObject(identItem)) {
    problems.push('manifest.files 缺 card/identity.json')
  } else {
    const digest = sha256(JSON.stringify(doc?.card?.identity ?? null))
    if (identItem.sha256 !== digest) problems.push(`card/identity.json 指纹对不上（清单 ${identItem.sha256 ?? '(空)'}，实际 ${digest}）`)
  }

  return { ok: problems.length === 0, problems, legacy }
}

/**
 * 导入 soul bundle：先核清单，不过就整包拒收（一个字节都不写）；再带 id 原样写事件
 * （已有的 id 跳过，所以同一份导两次是幂等的），最后写日记、恢复卡。
 * @returns {{ok:boolean, read:number, imported:number, skipped:number, failed:number,
 *   samples:Array<{id:string|null,error:string}>, diary:{read:number,imported:number}|null,
 *   card:object|null, chain:object|null, firstId:string|null, lastId:string|null,
 *   legacy:string[], reason?:string, problems?:string[]}}
 */
export async function importSoulBundle({ file, store, root, now = Date.now() } = {}) {
  const base = {
    ok: false,
    read: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    samples: [],
    diary: null,
    card: null,
    chain: null,
    firstId: null,
    lastId: null,
    legacy: [],
  }

  let doc
  try {
    doc = readSoulBundle(file)
  } catch (e) {
    return { ...base, reason: '格式不对', problems: [String(e?.message || e)] }
  }

  const verdict = verifySoulBundle(doc)
  if (!verdict.ok) {
    return { ...base, reason: '清单对不上', problems: verdict.problems, legacy: verdict.legacy }
  }

  const ts = Number(now) || Date.now()
  const events = bundleEventsOf(doc)
  const existing = new Set()
  try {
    for (const e of store?.readAll?.() || []) existing.add(String(e.id))
  } catch {}

  let imported = 0
  let skipped = 0
  let failed = 0
  let firstId = null
  let lastId = null
  const samples = []

  for (const e of sortedEvents(events)) {
    const id = String(e?.id ?? '')
    if (!id) {
      failed += 1
      if (samples.length < 5) samples.push({ id: null, error: '事件没有 id' })
      continue
    }
    if (existing.has(id)) {
      skipped += 1
      continue
    }
    try {
      await store.append({
        id,
        ts: Number(e.ts) || ts,
        day: e.day,
        type: e.type,
        text: e.text,
        refs: asArray(e.refs),
        confidence: e.confidence == null ? null : Number(e.confidence),
        source: e.source || 'migration',
        meta: { ...(isObject(e.meta) ? e.meta : {}), imported: 'soul' },
      })
      existing.add(id)
      imported += 1
      if (firstId == null) firstId = id
      lastId = id
    } catch (err) {
      failed += 1
      if (samples.length < 5) samples.push({ id, error: String(err?.message || err) })
    }
  }

  const diaryRows = bundleDiaryOf(doc)
  let diaryWritten = 0
  try {
    // 关键：过滤用 day != null（旧包有 day 0，真值判断会把它吃掉）。
    diaryWritten = store?.diaryPut?.(
      diaryRows.map((d) => ({ day: d.day, text: String(d.text ?? ''), imported: 'soul', at: ts })),
    ) || 0
  } catch (err) {
    if (samples.length < 5) samples.push({ id: null, error: `日记写回失败：${String(err?.message || err)}` })
  }

  let card = null
  if (root) {
    try {
      card = restoreCard(root, isObject(doc.card) ? doc.card : {}, { now: ts })
    } catch (err) {
      if (samples.length < 5) samples.push({ id: null, error: `卡恢复失败：${String(err?.message || err)}` })
      card = { ok: false, reason: String(err?.message || err) }
    }
  }

  let chain = null
  try {
    chain = store.verify()
  } catch {}

  return {
    ok: chain ? Boolean(chain.ok) && failed === 0 : failed === 0,
    read: events.length,
    imported,
    skipped,
    failed,
    samples,
    diary: { read: diaryRows.length, imported: diaryWritten },
    card,
    chain,
    firstId,
    lastId,
    legacy: verdict.legacy,
  }
}
