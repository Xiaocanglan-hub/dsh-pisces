// 状态面板的「galgame 式」渐进揭开（只给成年鱼）。
//
// 三条口径：
// 1. **深度只算领养之后**：成年鱼资产自带 90 天历史，最后一条是 `meta.kind='demo'` 的领养标记；
//    这条标记是基线，基线之前的历史一条都不算。深度 = 基线之后新增的、不是 `meta` 类的事件数。
//    天数同样从基线算起（领养后过了几个整天）。
// 2. **两把尺子任一达到就升档**：事件数够或天数够，都算到了这一档；下一档还差多少两个数都给。
// 3. **遮在服务端**：被锁的字段在 JSON 里就是 `null`，另外给 `masked` 标出哪些被遮过；
//    前端只负责渲染成「？？？」+ 模糊，不能指望它替服务端保守秘密。
import { isDemo } from './adopt.js'

const DAY = 86_400_000

/** 六档门槛。`reveals` 是这一档新揭开的字段名（与 /state 的键一致）。 */
export const REVEAL_LEVELS = [
  { level: 0, minEvents: 0, minDays: 0, reveals: [] },
  { level: 1, minEvents: 2, minDays: 1, reveals: ['day'] },
  { level: 2, minEvents: 6, minDays: 2, reveals: ['events'] },
  { level: 3, minEvents: 14, minDays: 4, reveals: ['order', 'dominance', 'attribution'] },
  { level: 4, minEvents: 28, minDays: 7, reveals: ['openQuestions'] },
  { level: 5, minEvents: 50, minDays: 14, reveals: ['dreams', 'verified'] },
  { level: 6, minEvents: 80, minDays: 30, reveals: ['refusals', 'scars'] },
]

/** 所有会被遮的字段；顺序就是面板上从轻到重的顺序。 */
export const MASKED_FIELDS = [
  'day',
  'events',
  'order',
  'dominance',
  'attribution',
  'openQuestions',
  'dreams',
  'verified',
  'refusals',
  'scars',
]

const byTime = (a, b) => Number(a?.ts) - Number(b?.ts) || Number(a?.seq) - Number(b?.seq)

/**
 * 算这条鱼现在能揭开多少。非成年鱼返回 null（调用方据此不加 reveal、也不遮）。
 *
 * @param {{events?: Array, now?: number}} [opts]
 * @returns {{level:number, next:{level:number, needEvents:number, needDays:number}|null,
 *   locked:Object<string, boolean>, depth:number, days:number, baselineSeq:number|null}|null}
 */
export function computeReveal({ events = [], now = Date.now() } = {}) {
  const all = [...(Array.isArray(events) ? events : [])].sort(byTime)
  if (!isDemo(all)) return null

  // 基线取最后一条 demo 标记（正常只有一条；重放/迁移时万一多一条，以最新的为准）。
  let at = -1
  for (let i = 0; i < all.length; i++) {
    if (all[i] && String(all[i]?.meta?.kind || '') === 'demo') at = i
  }
  const baseline = all[at]

  // meta 类（demo 标记、seen、dream_observed…）不是交流，不算深度。
  const depth = all.slice(at + 1).filter((e) => e && String(e?.type || '') !== 'meta').length

  const ts = Number(baseline?.ts)
  const days = Number.isFinite(ts) && ts > 0 ? Math.max(0, Math.floor((Number(now) - ts) / DAY)) : 0

  let level = 0
  for (const lv of REVEAL_LEVELS) {
    if (depth >= lv.minEvents || days >= lv.minDays) level = lv.level
  }

  const nextLevel = REVEAL_LEVELS.find((lv) => lv.level === level + 1) || null
  const next = nextLevel
    ? {
        level: nextLevel.level,
        needEvents: Math.max(0, nextLevel.minEvents - depth),
        needDays: Math.max(0, nextLevel.minDays - days),
      }
    : null

  const opened = new Set()
  for (const lv of REVEAL_LEVELS) {
    if (lv.level > level) continue
    for (const name of lv.reveals) opened.add(name)
  }
  const locked = {}
  for (const name of MASKED_FIELDS) locked[name] = !opened.has(name)

  return {
    level,
    next,
    locked,
    depth,
    days,
    baselineSeq: Number.isFinite(Number(baseline?.seq)) ? Number(baseline.seq) : null,
  }
}

/**
 * 返回遮好的新对象：被锁字段的值改成 null，`masked` 标出哪些是遮的，`reveal` 原样带上。
 * 不修改传入的 state。非成年鱼（reveal 为 null）原样返回，行为与现在一致。
 */
export function maskState(state, reveal) {
  if (!state || typeof state !== 'object') return state
  if (!reveal || typeof reveal !== 'object') return state

  const out = { ...state }
  const masked = {}
  for (const name of MASKED_FIELDS) {
    if (!reveal.locked?.[name]) continue
    out[name] = null
    masked[name] = true
  }
  // band 是从 dominance 折出来的，和主导一起遮，免得 JSON 里侧漏。
  if (masked.order || masked.dominance) out.band = null

  out.reveal = reveal
  out.masked = masked
  return out
}
