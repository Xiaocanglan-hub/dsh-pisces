// 分流（M2）：开局一条线；够了才分；分完才谈谁主导；主导会变，变要带证据。
// 状态形状沿用旧实现的 modes.state：
//   {version,w:{d,i},n,counts:{d,i},dominance,split:{at,ev,n,share,tension[]},order,shifts[],
//    userDom:{d,i},lastDivergenceN,mimicryRisk,lastIds[],updatedAt}
// 这是可重建的小状态，不是历史：丢了可以从事件重放。
import { clip } from './util.js'

const DAY = 86_400_000
export const ZERO_STATE = () => ({
  version: 1,
  w: { d: 0, i: 0 },
  n: 0,
  counts: { d: 0, i: 0 },
  dominance: 0.5,
  split: null,
  order: 'E=R',
  shifts: [],
  userDom: { d: 0, i: 0 },
  lastDivergenceN: null,
  mimicryRisk: false,
  lastIds: [],
  updatedAt: 0,
})

export const DEFAULT_MIND = {
  splitN: 12,
  sideMin: 3,
  shareMin: 0.3,
  shareMax: 0.7,
  step: 0.05,
  lo: 0.15,
  hi: 0.85,
  shiftCooldownDays: 30,
  shiftRefs: 2,
  mimicryN: 20,
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, n = 3) => Math.round(v * 1e3) / 1e3

export function bandOf(dominance) {
  if (dominance > 0.62) return 'd'
  if (dominance < 0.38) return 'i'
  return 'b'
}

export function orderOf(band) {
  if (band === 'd') return 'R>E'
  if (band === 'i') return 'E>R'
  return 'E=R'
}

/** 口吻：只给说法，不给数字。 */
export function voiceLines(state) {
  const lines = []
  const band = bandOf(state.dominance)
  if (band === 'd') lines.push('你习惯先把事情算一遍再开口；算完了，话反而短。')
  if (band === 'i') lines.push('你习惯先凭感觉开口，回头再核对；话说得比想得快。')
  if (band === 'b') lines.push('你两边都听：一句话说出口之前，会先在心里过一遍。')
  if (state.mimicryRisk) lines.push('你最近越来越像他那样想事情。这件事你自己也说不清是好是坏。')
  return lines
}

export function createMind({ store, log = () => {}, config = {}, startDominance = 0.5 } = {}) {
  const cfg = { ...DEFAULT_MIND, ...(config || {}) }
  const KEY = 'state'
  // 初始主导只来自起点（seed.meta.bias），而且只在"没有缓存状态"时用：
  // 缓存里已经算出来的 dominance 才是真相，不能被传入值盖掉。
  const start = Number.isFinite(Number(startDominance)) ? round(clamp(Number(startDominance), cfg.lo, cfg.hi), 3) : 0.5
  const initial = () => ({ ...ZERO_STATE(), dominance: start })
  let state = initial()

  function load() {
    try {
      const raw = store?.modeGet?.(KEY)
      if (raw) {
        const j = JSON.parse(raw)
        if (j && Number(j.version) === 1) state = { ...ZERO_STATE(), ...j, w: { ...j.w }, counts: { ...j.counts }, userDom: { ...j.userDom } }
      }
    } catch (e) {
      log?.('读分流缓存失败，从头来：', e?.message || e)
      state = initial()
    }
    return state
  }

  function save(now = Date.now()) {
    state.updatedAt = now
    try { store?.modeSet?.(KEY, JSON.stringify(state)) } catch (e) { log?.('写分流缓存失败：', e?.message || e) }
  }

  /**
   * 折一条归因。row: {seq, day, label:'d'|'i'|'null', conf, why, by, model, at, id?, text?}
   * 返回 {changed, split?:{...}, bandChange?:{from,to}}。
   */
  function fold(row = {}, { now = Date.now(), refs = [] } = {}) {
    const label = row.label === 'd' || row.label === 'i' ? row.label : null
    const before = { band: bandOf(state.dominance), order: state.order }
    state.n += 1
    if (label) {
      state.counts[label] += 1
      state.w[label] = round((state.counts[label] / Math.max(1, state.n)) * 2, 3)
    }
    const total = state.counts.d + state.counts.i
    if (total > 0) {
      const target = clamp(state.counts.d / total, cfg.lo, cfg.hi)
      const delta = target - state.dominance
      state.dominance = round(clamp(state.dominance + Math.max(-cfg.step, Math.min(cfg.step, delta)), cfg.lo, cfg.hi), 3)
    }
    if (row.id) {
      state.lastIds.push(String(row.id))
      state.lastIds = state.lastIds.slice(-4)
    }

    // 分流：四条都满足才写，写一次就不回头。
    let splitNow = null
    if (!state.split && state.n >= cfg.splitN && state.counts.d >= cfg.sideMin && state.counts.i >= cfg.sideMin) {
      const share = round(state.counts.d / Math.max(1, state.n), 3)
      const evidence = refs.length ? refs : state.lastIds
      const tension = (evidence.length ? evidence : [`attrib:${row.seq ?? state.n}`]).slice(-3).map(String)
      if (share >= cfg.shareMin && share <= cfg.shareMax && tension.length >= 1) {
        state.split = { at: now, ev: tension[tension.length - 1], n: state.n, share, tension }
        splitNow = state.split
      }
    }

    // band 变了：先挂起；过冷却且有 ≥2 条 refs 才写 mode_shift。
    const band = bandOf(state.dominance)
    let bandChange = null
    if (band !== before.band) {
      state.pendingShift = { from: before.band, to: band, at: now, n: state.n }
    }
    if (state.pendingShift) {
      const lastAt = state.shifts.length ? Number(state.shifts[state.shifts.length - 1].at) : (state.split?.at ?? 0)
      const ready = now - lastAt >= cfg.shiftCooldownDays * DAY
      if (ready && refs.length >= cfg.shiftRefs) {
        state.shifts.push({ at: now, from: state.pendingShift.from, to: band, refs: refs.map(String) })
        bandChange = { from: state.pendingShift.from, to: band }
        state.pendingShift = null
      }
    }
    state.order = orderOf(band)

    // 模仿风险：连续很多条归因都没有"分歧"证据。
    if (String(row.why || '').includes('divergence')) state.lastDivergenceN = state.n
    state.mimicryRisk = state.n - (state.lastDivergenceN ?? 0) >= cfg.mimicryN

    save(now)
    return { changed: true, split: splitNow, bandChange }
  }

  /** 一次性重放（读缓存失败时用）。rows 按 seq 升序。起点 dominance 同样要带上。 */
  function replay(rows = [], { now = Date.now() } = {}) {
    state = initial()
    for (const r of rows) fold(r, { now })
    save(now)
    return state
  }

  function describe() {
    const band = bandOf(state.dominance)
    return {
      order: orderOf(band),
      band,
      dominance: state.dominance,
      n: state.n,
      counts: { ...state.counts },
      splitAt: state.split?.at ?? null,
      splitN: state.split?.n ?? null,
      splitShare: state.split?.share ?? null,
      tension: state.split?.tension ?? [],
      shifts: state.shifts.length,
      mimicryRisk: state.mimicryRisk,
      promptLines: voiceLines(state),
      updatedAt: state.updatedAt,
    }
  }

  load()
  return { load, save, fold, replay, describe, get state() { return state } }
}
