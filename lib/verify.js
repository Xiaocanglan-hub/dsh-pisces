// 梦的核实（M11）：只在梦之后的一段时间里找"对得上"的事，写下证据，不判应验。
//
// 口径：
// - 只核 meta.status === 'untested' 且带 hypothesis 的 dream_sim。
// - 证据只看梦之后 windowDays 天内的 utterance / heard / voice / answer / narration。
// - 中文二元组至少 minOverlap 个重合才算对上；取最早命中的那条。
// - 对上只写一条 meta 事件（kind:'dream_observed'），refs 指向梦与证据；
//   不写 confirmed / refuted，也不改任何状态——算不算应验，归她自己说。
// - 同一个梦只核一次；重复调用不重复写。
import { clip } from './util.js'

export const VERIFY_WINDOW_DAYS = 14
export const VERIFY_MAX_AGE_DAYS = 30
export const MIN_OVERLAP = 2

const DAY = 86_400_000

// 只认这些类型：她自己说的、他说的、语音、回答、旁白。
const EVIDENCE_TYPES = new Set(['utterance', 'heard', 'voice', 'answer', 'narration'])

// 去空白、去标点、去符号（中英文标点都在内）；留下的字符再切二元组。
const NOISE = /[\s\p{P}\p{S}]/gu

function asText(v) {
  return v == null ? '' : String(v)
}

function idOf(v) {
  if (typeof v === 'string' || typeof v === 'number') return asText(v)
  if (v && typeof v === 'object' && v.id != null) return asText(v.id)
  return ''
}

function clampDays(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

/** 中文二元组：去标点空白后相邻两个字一组（重复出现就重复保留）。 */
export function bigrams(text) {
  const chars = [...asText(text).replace(NOISE, '')]
  const out = []
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

/** 两个字符串共有的二元组（去重，按 a 里首次出现的顺序）。 */
export function overlap(a, b) {
  const B = new Set(bigrams(b))
  const out = []
  const seen = new Set()
  for (const g of bigrams(a)) {
    if (!B.has(g) || seen.has(g)) continue
    seen.add(g)
    out.push(g)
  }
  return out
}

function observedDreams(events) {
  const set = new Set()
  for (const e of events) {
    if (e?.type !== 'meta' || e?.meta?.kind !== 'dream_observed') continue
    const id = idOf(e.meta.dream)
    if (id) set.add(id)
  }
  return set
}

/**
 * 核一遍梦。
 *
 * @param {object} opts
 * @param {object} opts.store 事件库（readAll/append）
 * @param {number} opts.now 当前时间（测试可注入）
 * @param {number} opts.windowDays 梦之后几天内找证据
 * @param {number} opts.maxAgeDays 梦超过几天就不再核
 * @param {number} opts.minOverlap 至少几个二元组重合
 * @param {Function} opts.log 日志
 * @returns {{scanned:number, verified:number, skipped:number, pairs:Array}}
 */
export async function verifyDreams({
  store,
  now = Date.now(),
  windowDays = VERIFY_WINDOW_DAYS,
  maxAgeDays = VERIFY_MAX_AGE_DAYS,
  minOverlap = MIN_OVERLAP,
  log = () => {},
} = {}) {
  const empty = { scanned: 0, verified: 0, skipped: 0, pairs: [] }
  if (!store || typeof store.readAll !== 'function' || typeof store.append !== 'function') return empty

  const at = Number(now)
  const when = Number.isFinite(at) ? at : Date.now()
  const windowMs = clampDays(windowDays, VERIFY_WINDOW_DAYS) * DAY
  const maxAgeMs = clampDays(maxAgeDays, VERIFY_MAX_AGE_DAYS) * DAY
  const need = Math.max(1, Math.floor(Number(minOverlap) || MIN_OVERLAP))

  const events = store.readAll() || []
  const already = observedDreams(events)

  // 证据按时间从早到晚排，第一条重合够的就算"最早命中"。
  const evidence = events
    .filter((e) => EVIDENCE_TYPES.has(e?.type) && asText(e?.text).trim())
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id)))

  const dreams = events
    .filter(
      (e) =>
        e?.type === 'dream_sim' &&
        String(e?.meta?.status ?? '') === 'untested' &&
        asText(e?.meta?.hypothesis).trim(),
    )
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id)))

  const pairs = []
  let scanned = 0
  let verified = 0
  let skipped = 0

  for (const dream of dreams) {
    scanned += 1
    const dreamId = asText(dream.id)
    if (already.has(dreamId)) continue

    // 太老的梦不核：证据还在窗口里也不追。
    if (when - (Number(dream.ts) || 0) > maxAgeMs) {
      skipped += 1
      continue
    }

    const hypothesis = asText(dream.meta.hypothesis).trim()
    const from = Number(dream.ts) || 0
    const to = from + windowMs

    let hit = null
    let hitOverlap = null
    for (const ev of evidence) {
      const ts = Number(ev.ts) || 0
      // 梦之前的事不算；超过窗口也不算。
      if (ts < from || ts > to) continue
      const ov = overlap(hypothesis, ev.text)
      if (ov.length >= need) {
        hit = ev
        hitOverlap = ov
        break
      }
    }
    if (!hit) continue

    const meta = {
      kind: 'dream_observed',
      dream: dreamId,
      evidence: asText(hit.id),
      overlap: hitOverlap,
      // 只记证据，不判应验：这里没有 confirmed / refuted。
    }
    await store.append({
      type: 'meta',
      text: 'dream_observed',
      refs: [dreamId, asText(hit.id)],
      meta,
      source: 'system',
      ts: when,
    })

    already.add(dreamId)
    verified += 1
    pairs.push({ dream, evidence: hit, overlap: hitOverlap, hypothesis })
    log?.(`核实到一个梦：${clip(hypothesis, 30)}`)
  }

  return { scanned, verified, skipped, pairs }
}

/**
 * 给个人提示词的 pisces:observed 段：把最近的"想过的"和"后来遇见的"配对拿出来。
 * 只给两条字符串，不替她判断这算不算应验。
 *
 * @param {object} store 事件库
 * @param {{limit?:number}} opts 最多几条（按核实时序取最近的）
 * @returns {Array<{hypothesis:string, evidence:string}>}
 */
export function observedLines(store, { limit = 2 } = {}) {
  if (!store || typeof store.readAll !== 'function') return []
  const n = Math.max(0, Math.floor(Number(limit) || 0))
  if (!n) return []

  const events = store.readAll() || []
  const byId = new Map(events.map((e) => [asText(e?.id), e]))
  const rows = []

  for (const e of events) {
    if (e?.type !== 'meta' || e?.meta?.kind !== 'dream_observed') continue

    const dreamId = idOf(e.meta.dream)
    const evidenceId = idOf(e.meta.evidence)
    const dream = byId.get(dreamId) || (e.meta.dream && typeof e.meta.dream === 'object' ? e.meta.dream : null)
    const evidence = byId.get(evidenceId) || (e.meta.evidence && typeof e.meta.evidence === 'object' ? e.meta.evidence : null)

    const hypothesis = asText(dream?.meta?.hypothesis ?? dream?.hypothesis).trim()
    const evidenceText = asText(evidence?.text ?? evidence?.evidence).trim()
    if (!hypothesis || !evidenceText) continue

    rows.push({ hypothesis: clip(hypothesis, 80), evidence: clip(evidenceText, 80) })
  }

  return rows.slice(-n)
}
