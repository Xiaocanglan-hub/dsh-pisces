// 分流（M2）：开局一条线；够了才分；分完才谈谁主导；主导会变，变要带证据。
// 状态形状沿用旧实现的 modes.state：
//   {version,w:{d,i},n,counts:{d,i},dominance,split:{at,ev,n,share,tension[]},order,shifts[],
//    userDom:number|null,recentLabels[],lastDivergenceN,mimicryRisk,lastIds[],updatedAt}
// userDom 是"最近 N 条归因里 d 占已判归因的比例"，没得判时是 null（不是 0）。
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
  userDom: null,
  recentLabels: [],
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
  // 用户主导度离 0.5 小于这个值，才算"看不出他偏哪边"——模仿风险的前提。
  mimicryBand: 0.15,
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

/**
 * 用户主导度：最近 n 条归因里 d 占已判归因（d + i）的比例。
 * - 窗口按"最近 n 条归因"取，null（纯描述）占窗口位置但不进分母；
 * - 窗口里一条 d/i 都没有 → null（还没得判，不是 0）。
 * @param {Array<{label?:string}|string>} rows 归因行（或裸 label）
 * @param {{n?:number}} [opts]
 * @returns {number|null} 0–1
 */
export function userDomOf(rows = [], { n = DEFAULT_MIND.mimicryN } = {}) {
  const limit = Math.max(1, Number(n) || DEFAULT_MIND.mimicryN)
  const window = (Array.isArray(rows) ? rows : [])
    .map((r) => (typeof r === 'string' ? r : r?.label))
    .slice(-limit)
  const judged = window.filter((l) => l === 'd' || l === 'i')
  if (!judged.length) return null
  return round(judged.filter((l) => l === 'd').length / judged.length, 3)
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
        if (j && Number(j.version) === 1) {
          state = {
            ...ZERO_STATE(),
            ...j,
            w: { ...j.w },
            counts: { ...j.counts },
            // 老缓存里 userDom 是没喂过数据的 {d,i}：不认，归为 null，等下一次 fold 重算。
            userDom: typeof j.userDom === 'number' && Number.isFinite(j.userDom) ? round(clamp(j.userDom, 0, 1), 3) : null,
            recentLabels: Array.isArray(j.recentLabels)
              ? j.recentLabels.map(String).filter((l) => l === 'd' || l === 'i' || l === 'null').slice(-cfg.mimicryN)
              : [],
          }
        }
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
   * opts.userDom：调用方已经算好的"最近 N 条归因的 d 占比"（number|null）；不给就用内部窗口。
   * 返回 {changed, split?:{...}, bandChange?:{from,to}}。
   */
  function fold(row = {}, { now = Date.now(), refs = [], userDom: givenUserDom } = {}) {
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

    // 用户主导度：最近 N 条归因里 d 的占比。null 归因占窗口位置，但不进分母。
    // 老缓存没有 recentLabels，就从这一条开始重新攒——宁可先判"看不出来"，也不要拿全局比例冒充。
    if (!Array.isArray(state.recentLabels)) state.recentLabels = []
    state.recentLabels.push(label || 'null')
    state.recentLabels = state.recentLabels.slice(-cfg.mimicryN)
    state.userDom = givenUserDom === undefined
      ? userDomOf(state.recentLabels, { n: cfg.mimicryN })
      : (givenUserDom == null || !Number.isFinite(Number(givenUserDom))
          ? null
          : round(clamp(Number(givenUserDom), 0, 1), 3))

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

    // 模仿风险：只有"连续很多条归因都没有分歧证据"、且"看不出他偏哪边"（userDom 在 0.5 附近）才亮。
    // 没有 userDom（还没得判）一律不亮：不拿 null 当 0，否则 i 多的鱼会在第 20 条后恒为 true。
    if (String(row.why || '').includes('divergence')) state.lastDivergenceN = state.n
    const noDivergence = state.n - (state.lastDivergenceN ?? 0) >= cfg.mimicryN
    const nearHalf = state.userDom != null && Math.abs(state.userDom - 0.5) < cfg.mimicryBand
    state.mimicryRisk = noDivergence && nearHalf

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
      userDom: state.userDom,
      mimicryRisk: state.mimicryRisk,
      promptLines: voiceLines(state),
      updatedAt: state.updatedAt,
    }
  }

  load()
  return { load, save, fold, replay, describe, get state() { return state } }
}
