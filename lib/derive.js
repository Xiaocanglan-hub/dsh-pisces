// 从事件流算"此刻的她"。纯函数：同一串事件 + 同一个 now，永远算出同一个结果。
// 两条和 fish 一致的口径：说出口不等于认领（uncommitted 不进信念）；梦不参与派生。
import { clip } from './util.js'

const DAY = 86_400_000
const startOfDay = (ts) => {
  const d = new Date(Number(ts) || 0)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const byTime = (a, b) => Number(a.ts) - Number(b.ts) || Number(a.seq) - Number(b.seq)

export function isUncommitted(ev) {
  return Array.isArray(ev?.meta?.flags) && ev.meta.flags.includes('uncommitted')
}

/** @returns {{day:number, beliefs:Array, refuted:Array, refusals:Array, scars:Array, narrations:Array, name:string|null, selfmodAttempts:Array}} */
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
    if (e.type === 'refusal') { refusals.push({ id: e.id, text: e.text, day: e.day }); continue }
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

  return { day, beliefs, refuted, refusals, scars, narrations, name, selfmodAttempts }
}

/** 折成给提示词的行：不带任何数字，不带权重。 */
export function selfLines(d, { maxBeliefs = 2 } = {}) {
  const lines = []
  for (const b of (d.beliefs || []).slice(0, maxBeliefs)) lines.push(`你以前说过：${clip(b.text, 60)}`)
  if (d.name) lines.push(`你管他叫${d.name}。`)
  const scar = (d.scars || [])[0]
  if (scar) lines.push(`有一件事你到现在没想清楚：${clip(scar.text, 40)}`)
  return lines
}
