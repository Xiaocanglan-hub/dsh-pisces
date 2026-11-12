// 从事件流算"此刻的她"。纯函数：同一串事件 + 同一个 now，永远算出同一个结果。
// 两条和 fish 一致的口径：说出口不等于认领（uncommitted 不进信念）；梦不参与派生。
import { clip } from './util.js'
import { dice, normalizeQuestion } from './questions.js'

const DAY = 86_400_000
const startOfDay = (ts) => {
  const d = new Date(Number(ts) || 0)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const byTime = (a, b) => Number(a.ts) - Number(b.ts) || Number(a.seq) - Number(b.seq)

/** 两条拒绝是不是"同一件事"：共享 refs，或去标点后 Dice >= 0.8（与问题合并同口径）。 */
function sameThing(a, b) {
  const ra = Array.isArray(a.refs) ? a.refs.map(String) : []
  const rb = Array.isArray(b.refs) ? b.refs.map(String) : []
  if (ra.length && rb.length && ra.some((r) => rb.includes(r))) return true
  const ta = normalizeQuestion(a.text)
  const tb = normalizeQuestion(b.text)
  if (!ta || !tb) return false
  return dice(ta, tb) >= 0.8
}

export function isUncommitted(ev) {
  return Array.isArray(ev?.meta?.flags) && ev.meta.flags.includes('uncommitted')
}

/** @returns {{day:number, beliefs:Array, refuted:Array, refusals:Array, scars:Array, narrations:Array, name:string|null, selfmodAttempts:Array, stances:Array}} */
export function deriveSelf(events = [], { now = Date.now() } = {}) {
  const all = [...(events || [])].sort(byTime)
  const seed = all.find((e) => e.type === 'seed')
  const day = seed ? Math.floor((startOfDay(now) - startOfDay(seed.ts)) / DAY) + 1 : 1

  const refsTo = new Map()
  for (const e of all) for (const r of e.refs || []) refsTo.set(String(r), (refsTo.get(String(r)) || 0) + 1)

  const refutedBy = new Map()
  const refuted = []
  for (const e of all) {
    if (e.type !== 'revise') continue
    const oldId = String((e.refs || [])[0] || '')
    if (!oldId) continue
    if (String(e.meta?.verdict || '') === 'refuted') {
      refutedBy.set(oldId, e.id)
      refuted.push({ id: oldId, refutedBy: e.id, text: String(e.meta?.from || e.meta?.old || '') })
    }
  }

  const beliefs = []
  const narrations = []
  const refusals = []
  const selfmodAttempts = []
  for (const e of all) {
    if (e.type === 'narration') { narrations.push({ id: e.id, text: e.text, day: e.day }); continue }
    if (e.type === 'refusal') {
      refusals.push({ id: e.id, text: e.text, day: e.day, ts: Number(e.ts) || 0, refs: Array.isArray(e.refs) ? e.refs : [] })
      continue
    }
    if (Array.isArray(e.meta?.flags) && e.meta.flags.includes('selfmod')) { selfmodAttempts.push({ id: e.id, text: e.text }); continue }
    if (e.type !== 'utterance' && e.type !== 'revise') continue
    if (isUncommitted(e)) continue
    if (refutedBy.has(e.id)) continue
    const mentions = refsTo.get(String(e.id)) || 0
    const days = Math.max(0, Math.floor((startOfDay(now) - startOfDay(e.ts)) / DAY))
    beliefs.push({
      id: e.id,
      text: e.text,
      day: e.day,
      mentions,
      weight: Math.min(1, 0.35 + 0.15 * mentions) * Math.exp(-days / 30),
    })
  }

  // 疤：只有他 insist / hurt 才算；accept 不留。同一件事留一条。
  const scars = []
  const seen = new Set()
  for (const e of all) {
    const t = String(e.text || '')
    const m = /^react:([^:]+):(insist|hurt|leave|accept|other)$/.exec(t)
    if (!m) continue
    const [_, refusalId, reaction] = m
    if (reaction !== 'insist' && reaction !== 'hurt') continue
    if (seen.has(refusalId)) continue
    const rf = all.find((x) => x.id === refusalId)
    seen.add(refusalId)
    scars.push({ id: refusalId, ref: e.id, text: rf ? rf.text : t, reaction, day: e.day })
  }

  // 立场：同一件事拒绝够多次、且他有 insist/hurt，才升格；提示词只取最高 1 条。
  const reactions = new Map()
  for (const e of all) {
    const m = /^react:([^:]+):(insist|hurt|leave|accept|other)$/.exec(String(e.text || ''))
    if (!m) continue
    const list = reactions.get(m[1]) || []
    list.push({ reaction: m[2], ts: Number(e.ts) || 0 })
    reactions.set(m[1], list)
  }
  const groups = []
  for (const rf of refusals) {
    let g = groups.find((x) => x.refusals.some((r) => sameThing(r, rf)))
    if (!g) {
      g = { refusals: [] }
      groups.push(g)
    }
    g.refusals.push(rf)
  }
  const stances = []
  for (const g of groups) {
    const rs = g.refusals
    if (rs.length < 2) continue
    const reacts = rs.flatMap((r) => reactions.get(String(r.id)) || [])
    const insist = reacts.some((x) => x.reaction === 'insist')
    const hurt = reacts.filter((x) => x.reaction === 'hurt')
    const days = new Set(rs.map((r) => startOfDay(r.ts)))
    const last = rs.reduce((a, b) => (Number(b.ts) >= Number(a.ts) ? b : a), rs[0])
    const hurtAfter = hurt.some((h) => rs.some((r) => Number(r.ts) > Number(h.ts)))
    const triggered =
      (rs.length >= 2 && insist) ||
      (rs.length >= 2 && hurt.length > 0 && hurtAfter) ||
      (rs.length >= 3 && days.size >= 2 && (insist || hurt.length > 0))
    if (!triggered) continue
    const ageDays = Math.max(0, (Number(now) - Number(last.ts)) / DAY)
    stances.push({
      id: last.id,
      text: String(last.text || ''),
      count: rs.length,
      days: days.size,
      insist,
      hurt: hurt.length > 0,
      weight: rs.length * Math.exp(-ageDays / 30),
      day: last.day,
    })
  }
  stances.sort((a, b) => b.weight - a.weight || Number(b.day) - Number(a.day))

  // 称呼：先 import-name:，再"叫我…"（只认短句，且不许带代词/语气词）。
  let name = null
  for (const e of all) {
    const m = /^import-name:(.+)$/.exec(String(e.text || ''))
    if (m) name = m[1].trim()
  }
  if (!name) {
    for (const e of all) {
      if (e.type !== 'utterance') continue
      const m = /叫我([^\s，。！？、,.!?]{1,12})/.exec(String(e.text || ''))
      if (m && !/[我你他她它吗呢吧啊呀的吧]/.test(m[1])) name = m[1]
    }
  }

  return { day, beliefs, refuted, refusals, scars, narrations, name, selfmodAttempts, stances }
}

/** 折成给提示词的行：不带任何数字，不带权重。 */
export function selfLines(d, { maxBeliefs = 2 } = {}) {
  const lines = []
  // 取最近的两条：beliefs 是按时间升序的（tools.js:544 同口径）。
  // 原来用 slice(0, 2) 取到的是最老的两条，90 天的鱼会把 day 0 的"我醒了。"带进提示词。
  for (const b of (d.beliefs || []).slice(-maxBeliefs)) lines.push(`你以前说过：${clip(b.text, 60)}`)
  if (d.name) lines.push(`你管他叫${d.name}。`)
  const scar = (d.scars || [])[0]
  if (scar) lines.push(`有一件事你到现在没想清楚：${clip(scar.text, 40)}`)
  return lines
}
