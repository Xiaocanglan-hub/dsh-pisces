// 从 dsh-fish 搬家（M12）：fish 的 events.jsonl + diary/*.md → 本库。
//
// 四条都是踩过的坑（知识库 n7、persona-study 07 §3）：
// 1. fish 的 ts 是 ISO 字符串。Number('2026-11-09T…') 是 NaN，再 || Date.now() 会把
//    625 条历史全记成"现在"（天数、衰减、检索时间权重一起塌）。这里一律 Date.parse；
//    解析失败计 badTs，用上一行的时间兜底，绝不 Number(ts) 之后再判断。
// 2. refs 不一定是事件 id：voice/heard 会把 B 站 BV 号写进 refs，照抄会被 validateEvent
//    拒（实测丢 8 条）。ev_* / 26 位 ULID 进 refs，其余进 meta.foreignRefs，出处不丢。
// 3. verdict / flags 会被 schema 裁掉：必须进 meta，否则 revise 的"refined/refuted"没了，
//    指认链只剩一半。flags 里的 uncommitted 照样留着——derive 会跳过它，不算她的判断。
// 4. fish 的 day 是"第几天"，和本库 day（YYYY-MM-DD）不是一个东西：存 meta.fishDay；
//    本库的 day 由 ts 现算（store.append 负责）。
//
// 源文件只读：只 readFileSync，不写回、不移动、不改名。重复导入靠 id 幂等。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { ALL_TYPES } from './schema.js'
import { newEventId, isObject } from './util.js'

// fish 的事件 id：迁移过来的都是这个形状；26 位 ULID 也认（老库里两种都有）。
const EV_ID_RE = /^ev_[0-9A-Za-z_-]+$/
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
// 日记文件名就是 day，只认 YYYY-MM-DD.md（别的名字不猜）。
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/
// 失败样本只留前 50 条，够定位问题；failed 计数不受影响。
const MAX_SAMPLES = 50

/**
 * fish 的时间戳 → 毫秒。认 ISO 字符串（真实 fish）、毫秒数字（测试样本）、
 * 纯数字字符串；其它一律 NaN，交给调用方计 badTs。
 * 注意：绝不先 Number() 再判断——ISO 字符串会得到 NaN 并被 || 吞成"现在"。
 */
export function parseFishTs(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
  if (typeof raw !== 'string') return NaN
  const s = raw.trim()
  if (!s) return NaN
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : NaN
}

/** refs 分流：指向事件 id 的留 refs，其余（BV 号、外链）进 meta.foreignRefs。 */
function splitRefs(raw) {
  const refs = []
  const foreign = []
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]
  for (const x of list) {
    const s = String(x ?? '').trim()
    if (!s) continue
    const isEvent = EV_ID_RE.test(s) || ULID_RE.test(s)
    const bucket = isEvent ? refs : foreign
    if (!bucket.includes(s)) bucket.push(s)
  }
  return { refs, foreign }
}

/** fish 的 day（第几天）原样留成数字；认不出就给字符串，不丢。 */
function fishDayOf(v) {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = String(v).trim()
  if (!s) return null
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s
}

/** 把 verdict / flags / foreignRefs / fishDay 折进 meta（已有 meta 先摊平）。 */
function metaOf(o, foreign) {
  const meta = isObject(o.meta) ? { ...o.meta } : {}
  if (foreign.length) {
    const had = Array.isArray(meta.foreignRefs) ? meta.foreignRefs.map(String) : []
    for (const x of foreign) if (!had.includes(x)) had.push(x)
    meta.foreignRefs = had
  }
  if (o.verdict != null && String(o.verdict).trim() !== '') meta.verdict = String(o.verdict)
  if (o.flags != null) {
    const flags = (Array.isArray(o.flags) ? o.flags : [o.flags]).map(String).filter(Boolean)
    if (flags.length) {
      const had = Array.isArray(meta.flags) ? meta.flags.map(String) : []
      for (const f of flags) if (!had.includes(f)) had.push(f)
      meta.flags = had
    }
  }
  const fishDay = fishDayOf(o.fishDay ?? o.day)
  if (fishDay != null) meta.fishDay = fishDay
  return meta
}

const sample = (out, id, error) => {
  if (out.samples.length < MAX_SAMPLES) out.samples.push({ id: id == null ? null : String(id), error: String(error ?? '') })
}

/**
 * 搬 fish 的 events.jsonl。
 * 返回 { read, imported, skipped, failed, badTs, unknownType, samples, firstId, lastId, chain }：
 * - read        读了几个非空行
 * - imported    真正进了事件流的
 * - skipped     id 已存在 / 未知类型（两类都算进来，不硬塞）
 * - failed      坏 JSON、形状不对、append 被校验拒的
 * - badTs       时间戳解析失败、用上一行兜底的条数（不是失败）
 * - chain       store.verify() 的结果，搬完就知道链断没断
 */
export async function importFishEvents({ file, store, log = () => {} } = {}) {
  if (!file) throw new Error('要给我 fish 的事件文件')
  if (!store || typeof store.append !== 'function' || typeof store.readAll !== 'function') throw new Error('要给我一个打开的 store')
  if (!existsSync(file)) throw new Error(`找不到 fish 事件文件：${file}`)

  const out = {
    read: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    badTs: 0,
    unknownType: 0,
    samples: [],
    firstId: null,
    lastId: null,
    chain: null,
  }

  const seen = new Set(store.readAll().map((e) => String(e.id)))
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  let lastTs = Date.now()

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    out.read += 1

    let o
    try {
      o = JSON.parse(line)
    } catch (e) {
      out.failed += 1
      sample(out, null, `不是 JSON：${e?.message || e}`)
      continue
    }
    if (!isObject(o)) {
      out.failed += 1
      sample(out, null, '这一行不是对象')
      continue
    }

    // id 原样带；没有 id 才现造一个（不丢数据，但这份就做不到按 id 幂等）。
    const id = o.id == null || String(o.id).trim() === '' ? newEventId(lastTs) : String(o.id).trim()
    if (o.id == null || String(o.id).trim() === '') log?.(`这条没有 id，现造一个：${id}`)

    // 已有 id 直接跳过——同一份导两次，第二次 imported=0。
    if (seen.has(id)) {
      out.skipped += 1
      continue
    }

    let ts = parseFishTs(o.ts)
    if (!Number.isFinite(ts)) {
      out.badTs += 1
      ts = lastTs
      log?.(`坏时间戳（${JSON.stringify(o.ts)}），用上一行的时间兜底：${new Date(ts).toISOString()}`)
    }
    lastTs = ts

    const type = String(o.type ?? '').trim()
    if (!ALL_TYPES.includes(type)) {
      out.unknownType += 1
      out.skipped += 1
      log?.(`未知类型，跳过：${type || '(空)'}（${id}）`)
      continue
    }

    const { refs, foreign } = splitRefs(o.refs)
    const meta = metaOf(o, foreign)
    const confidence = o.confidence == null ? null : Number(o.confidence)

    try {
      const ev = await store.append({
        id,
        ts,
        type,
        text: String(o.text ?? ''),
        refs,
        meta,
        confidence: Number.isFinite(confidence) ? confidence : null,
        source: 'migration',
      })
      out.imported += 1
      if (out.firstId == null) out.firstId = ev.id
      out.lastId = ev.id
      seen.add(ev.id)
    } catch (e) {
      out.failed += 1
      sample(out, id, e?.message || e)
    }
  }

  out.chain = store.verify()
  log?.(
    `事件：读 ${out.read}，导入 ${out.imported}，跳过 ${out.skipped}（未知类型 ${out.unknownType}），` +
      `失败 ${out.failed}，坏时间戳 ${out.badTs}；链 ${out.chain?.ok ? '完整' : '断了'}（${out.chain?.count ?? 0} 条）`,
  )
  return out
}

/**
 * 搬 fish 的日记：<dir>/diary/YYYY-MM-DD.md → store.diaryPut，day 取文件名。
 * 原文一字不改（不裁、不转义、不整理换行）；已存在的 day 跳过——重复导入幂等。
 * 返回 { read, imported, skipped }。
 */
export async function importFishDiary({ dir, store, log = () => {} } = {}) {
  if (!dir) throw new Error('要给我 fish 的目录')
  if (!store || typeof store.diaryPut !== 'function' || typeof store.diaryAll !== 'function') throw new Error('要给我一个打开的 store')

  const out = { read: 0, imported: 0, skipped: 0 }
  const diaryDir = path.join(path.resolve(String(dir)), 'diary')
  if (!existsSync(diaryDir)) {
    log?.(`没有 diary 目录，跳过：${diaryDir}`)
    return out
  }

  const have = new Set(store.diaryAll().map((d) => String(d.day)))
  const files = readdirSync(diaryDir)
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .sort()

  for (const name of files) {
    out.read += 1
    const m = DAY_FILE_RE.exec(name)
    if (!m) {
      out.skipped += 1
      log?.(`日记文件名不是 YYYY-MM-DD.md，跳过：${name}`)
      continue
    }
    const day = m[1]
    if (have.has(day)) {
      out.skipped += 1
      continue
    }

    const full = path.join(diaryDir, name)
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch (e) {
      out.skipped += 1
      log?.(`日记读不了，跳过：${name}（${e?.message || e}）`)
      continue
    }
    let at = Date.now()
    try {
      const t = Number(statSync(full).mtimeMs)
      if (Number.isFinite(t) && t > 0) at = t
    } catch {}

    // imported 只标来源（'fish'），正文原样落库；at 用文件时间，不是"现在"。
    store.diaryPut([{ day, text, imported: 'fish', at }])
    have.add(day)
    out.imported += 1
  }

  log?.(`日记：读 ${out.read}，导入 ${out.imported}，跳过 ${out.skipped}`)
  return out
}

/**
 * 整搬一个 fish 根目录：events.jsonl + diary/*.md。
 * 返回 { events, diary, count, firstId, lastId, chain }——count 是事件 + 日记的天数之和。
 * events.jsonl 不在时按 0 条算（只有日记的目录也能搬），日记照搬。
 */
export async function importFishRoot({ dir, store, log = () => {} } = {}) {
  if (!dir) throw new Error('要给我 dsh-fish 的目录')
  const root = path.resolve(String(dir))
  const eventsFile = path.join(root, 'events.jsonl')

  let events
  if (existsSync(eventsFile)) {
    events = await importFishEvents({ file: eventsFile, store, log })
  } else {
    log?.(`没有 events.jsonl，只搬日记：${root}`)
    events = {
      read: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      badTs: 0,
      unknownType: 0,
      samples: [],
      firstId: null,
      lastId: null,
      chain: store.verify(),
    }
  }

  const diary = await importFishDiary({ dir: root, store, log })
  const count = events.imported + diary.imported
  const report = {
    events,
    diary,
    count,
    firstId: events.firstId,
    lastId: events.lastId,
    chain: events.chain,
  }
  log?.(
    `搬完：事件 ${events.imported}、日记 ${diary.imported} 天，合计 ${count}；` +
      `链 ${report.chain?.ok ? '完整' : '断了'}`,
  )
  return report
}
