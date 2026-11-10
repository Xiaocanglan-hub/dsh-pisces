// 起点（M13）：她是谁，只写一次。写完就是一条 seed 事件，从此不可改、不可覆盖、没有编辑入口。
// 初始偏向只决定"一开始先靠哪边"，不是性格滑条：它进 seed.meta，由 createMind() 当起点读出来。
import { dayOf } from './util.js'

export const MAX_FRAGMENTS = 3
export const MAX_FRAGMENT = 200
export const MAX_TOTAL = 500

export const BIASES = [
  { id: 'balanced', name: '两边都算（默认）', hint: '没有偏向，靠经历慢慢长出来', dominance: 0.5 },
  { id: 'rational', name: '先算一遍', hint: '先把边界算清楚，再开口', dominance: 0.65 },
  { id: 'intuitive', name: '先凭感觉', hint: '先有反应，再回头核对', dominance: 0.35 },
]

/** 偏向 id → 记录；认不出就是 null。 */
export function biasOf(id) {
  const key = String(id ?? '').trim()
  return BIASES.find((b) => b.id === key) || null
}

/**
 * 校验起点正文：空白段先丢掉再算。
 * 返回 { ok, problems, fragments, chars }；problems 是可以直接显示在面板上的人话。
 */
export function validateSeed(texts = []) {
  const list = Array.isArray(texts) ? texts : [texts]
  const fragments = list.map((t) => String(t ?? '').trim()).filter((t) => t.length > 0)
  const chars = fragments.reduce((n, t) => n + t.length, 0)
  const problems = []
  if (!fragments.length) {
    problems.push('起点还是空的：至少写一段')
  }
  if (fragments.length > MAX_FRAGMENTS) {
    problems.push(`最多写 ${MAX_FRAGMENTS} 段，现在是 ${fragments.length} 段`)
  }
  const over = fragments.findIndex((t) => t.length > MAX_FRAGMENT)
  if (over >= 0) {
    problems.push(`第 ${over + 1} 段太长了：${fragments[over].length} 字，每段最多 ${MAX_FRAGMENT} 字`)
  }
  if (chars > MAX_TOTAL) {
    problems.push(`合计 ${chars} 字，超过 ${MAX_TOTAL} 字的上限`)
  }
  return { ok: problems.length === 0, problems, fragments, chars }
}

/** 事件流里的起点：第一条 seed。导入来的（source:'migration'）也算。 */
export function seedOf(events = []) {
  const list = Array.isArray(events) ? events : []
  return list.find((e) => e && e.type === 'seed') || null
}

/** 初始主导：按 seed.meta.bias；没有 seed、或者 seed 没写偏向，都退回 0.5。 */
export function initialDominance(events = []) {
  const seed = seedOf(events)
  const bias = biasOf(seed?.meta?.bias)
  return bias ? bias.dominance : 0.5
}

/**
 * 写下起点。只写一次：已有 seed（含导入的）就拒绝。
 * 成功 → { ok:true, event, fragments, chars }；失败 → { ok:false, reason, problems? }。
 */
export async function writeSeed({ store, texts = [], bias = 'balanced', now = Date.now() } = {}) {
  if (!store || typeof store.append !== 'function' || typeof store.readAll !== 'function') {
    return { ok: false, reason: '事件库还没准备好，起点写不进去' }
  }

  let events = []
  try {
    events = store.readAll() || []
  } catch (e) {
    return { ok: false, reason: `读事件流失败：${e?.message || e}` }
  }
  if (seedOf(events)) {
    return { ok: false, reason: '已经有起点了，不能再写' }
  }

  const pick = biasOf(bias)
  if (!pick) {
    const names = BIASES.map((b) => b.name).join('、')
    return { ok: false, reason: `不认识的偏向：${String(bias || '(空)')}；只能选 ${names}` }
  }

  const v = validateSeed(texts)
  if (!v.ok) {
    return { ok: false, reason: v.problems.join('；'), problems: v.problems }
  }

  const ts = Number(now) || Date.now()
  const event = await store.append({
    ts,
    day: dayOf(ts),
    type: 'seed',
    text: v.fragments.join('\n\n'),
    source: 'owner',
    meta: {
      kind: 'owner-seed',
      fragments: v.fragments,
      chars: v.chars,
      bias: pick.id,
      dominance: pick.dominance,
    },
  })
  return { ok: true, event, fragments: v.fragments, chars: v.chars }
}
