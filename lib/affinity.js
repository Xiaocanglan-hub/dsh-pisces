// 好感（M7）：从事件流推导，不新增计数器表。
//
// 口径（与 README 一致，别在这里加系数）：
// - 初始 10；每共同存在一天 +0.5（最多 +15，即 30 天上限）；
// - 他回话 heard +1.5；她开口 utterance +0.5；answer +2；reunion +5；diary +1；grant/grant_offer +1；
// - **重复型加分各自封顶**（2026-11-10 加）：utterance 累计 ≤15、heard ≤20、diary ≤10。
//   原因：合并旧数据时一次灌进几百条，不封顶会直接把好感顶到 100（5 天就「离不开」）。
// - 她拒绝 refusal 不扣；他坚持/受伤（react 的 insist / hurt）分别 -3 / -6；
// - 被回答过的问题（questions 表 status='answered'）每条 +2，最多 +10；
// - 冷落：距最后一条**真人互动**超过 7 天，每多一天 -1（最多 -10）；
// - clamp 0–100；分档 0–19 陌生 / 20–39 眼熟 / 40–59 亲近 / 60–79 依赖 / 80–100 离不开。
//
// 三件不参与好感的事：
// 1. `meta` 类（含 `seen:`、`dream_observed`、`card_patch`）不加好感——那是机器记的，不是交流；
// 2. `dream` / `narration` / `revise` 不在加分表里，按 0 处理；
// 3. `demo` 样本的事件照算（她是养大的，本来就高），领养后新增的互动一样正常加减。
//
// 遮罩（谁看得到数字）不在这里决定：`maskAffinity` 只负责按 reveal.level 把数字藏起来，
// 心意（tier/label/nextAt）永远给。见 lib/reveal.js。

const DAY = 86_400_000

export const INITIAL = 10
export const MAX = 100
export const DAILY = 0.5
export const DAILY_CAP = 15
export const ANSWER_STEP = 2
export const ANSWER_CAP = 10
export const IDLE_DAYS = 7
export const IDLE_STEP = 1
export const IDLE_CAP = 10
export const REVEAL_UNMASK_LEVEL = 2

/** 加分表：type → 分。不在表里的类型（refusal/dream/narration/revise…）按 0 处理。 */
export const GAIN = {
  heard: 1.5,
  utterance: 0.5,
  answer: 2,
  reunion: 5,
  diary: 1,
  grant: 1,
  grant_offer: 1,
}

/** 他坚持/受伤的扣分。leave/accept/other 不扣（拒绝本身也不扣）。 */
export const REACT_LOSS = { insist: 3, hurt: 6 }

/** 重复型加分的累计上限：防止一次性导入几百条把好感顶满。 */
export const GAIN_CAPS = {
  utterance: 15,
  heard: 20,
  diary: 10,
}

/** 五档：min 是这一档的门槛。 */
export const TIERS = [
  { min: 0, label: '陌生' },
  { min: 20, label: '眼熟' },
  { min: 40, label: '亲近' },
  { min: 60, label: '依赖' },
  { min: 80, label: '离不开' },
]

const startOfDay = (ts) => {
  const d = new Date(Number(ts) || 0)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const round1 = (n) => Math.round(Number(n) * 10) / 10

const byTime = (a, b) => Number(a.ts) - Number(b.ts) || Number(a.seq || 0) - Number(b.seq || 0)

/** 机器事件：`meta` 类、`seen:`、`dream_observed`、`card_patch`。它们不加好感，也不算"最后一条互动"。 */
export function isMachineEvent(ev) {
  const type = String(ev?.type || '')
  const kind = String(ev?.meta?.kind || '')
  const text = String(ev?.text || '')
  if (type === 'meta' || type === 'card_patch') return true
  if (kind === 'dream_observed' || kind === 'card_patch' || kind === 'seen') return true
  return /^seen:/.test(text)
}

/** 一条事件是不是"他坚持/受伤"；是就回 'insist' / 'hurt'，不是回 null。 */
export function reactionOf(ev) {
  const type = String(ev?.type || '')
  const kind = String(ev?.meta?.kind || '')
  const text = String(ev?.text || '')
  // 形状照 tools/make-adult.mjs：type:'meta'、text:'react:<refusalId>:<reaction>'、meta.kind:'react'
  const m = /^react:[^:]+:(insist|hurt|leave|accept|other)$/.exec(text)
  if (m) return Object.prototype.hasOwnProperty.call(REACT_LOSS, m[1]) ? m[1] : null
  const meta = ev?.meta || {}
  const reaction = String(meta.reaction ?? meta.action ?? '')
  if (type === 'react' || kind === 'react') {
    return Object.prototype.hasOwnProperty.call(REACT_LOSS, reaction) ? reaction : null
  }
  // 只认"这条事件本身就是 react"的情况；别的类型哪怕带了 reaction 也不扣。
  if (reaction && (kind === 'react' || /^react:/.test(text))) return reaction
  return null
}

/** 分数 → 档位。分档边界测试直接打这里。 */
export function tierOf(value) {
  const v = Math.min(MAX, Math.max(0, Number(value) || 0))
  let tier = 0
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (v >= TIERS[i].min) {
      tier = i
      break
    }
  }
  const next = tier < TIERS.length - 1 ? TIERS[tier + 1].min : null
  return { tier, label: TIERS[tier].label, nextAt: next }
}

/**
 * 猜好感。纯函数：同一串事件 + 同一个 now + 同一批问题，永远算出同一个结果。
 * @param {{events?: Array, questions?: Array, now?: number}} input
 *   questions 是 questions 表的行（读 status='answered' 用；不传就当没有）。
 * @returns {{value:number, tier:number, label:string, nextAt:number|null, days:number, earned:number, lost:number}}
 */
export function computeAffinity({ events = [], questions = [], now = Date.now() } = {}) {
  const t = Number(now) || Date.now()
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.ts != null)
    .slice()
    .sort(byTime)

  // 共同存在：从第一条事件那天算到今天，整天数 × 0.5，封顶 +15。
  const firstTs = list.length ? Number(list[0].ts) : null
  const days = firstTs == null ? 0 : Math.max(0, Math.floor((startOfDay(t) - startOfDay(firstTs)) / DAY))
  const dayBonus = Math.min(DAILY_CAP, days * DAILY)

  let earned = dayBonus
  let lastRealTs = null
  const typed = {}
  for (const e of list) {
    if (isMachineEvent(e)) continue
    const type = String(e.type || '')
    const gain = GAIN[type] || 0
    if (gain) typed[type] = (typed[type] || 0) + gain
    lastRealTs = Number(e.ts)
  }
  for (const [type, sum] of Object.entries(typed)) {
    const cap = GAIN_CAPS[type]
    earned += cap == null ? sum : Math.min(cap, sum)
  }

  const answered = (Array.isArray(questions) ? questions : []).filter(
    (q) => String(q?.status ?? '') === 'answered',
  ).length
  earned += Math.min(ANSWER_CAP, answered * ANSWER_STEP)

  let lost = 0
  for (const e of list) {
    const reaction = reactionOf(e)
    if (reaction) lost += REACT_LOSS[reaction]
  }

  // 冷落：最后一条**真人互动**（不是机器事件）超过 7 天，每多一天 -1，最多 -10。
  const idleDays = lastRealTs == null ? 0 : Math.max(0, Math.floor((t - lastRealTs) / DAY))
  const idle = idleDays > IDLE_DAYS ? Math.min(IDLE_CAP, (idleDays - IDLE_DAYS) * IDLE_STEP) : 0
  lost += idle

  earned = round1(earned)
  lost = round1(lost)
  const value = round1(Math.min(MAX, Math.max(0, INITIAL + earned - lost)))
  return { value, ...tierOf(value), days, earned, lost }
}

/**
 * 遮罩：心意（tier/label/nextAt）永远给，数字要聊得够深（level >= 2）才给。
 * 普通鱼传 level = Infinity（不遮）。返回新对象，不改传进来的那个。
 */
export function maskAffinity(affinity, level = 0) {
  if (affinity == null) return null
  if (Number(level) >= REVEAL_UNMASK_LEVEL) return { ...affinity, masked: false }
  return {
    ...affinity,
    value: null,
    earned: null,
    lost: null,
    masked: true,
  }
}
