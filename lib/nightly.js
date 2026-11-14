// 夜间流水线（M4）：归因 → 折进分流 → 同步问题 → 做梦 → 核实 → 自学。
//
// 口径：
// - 默认窗口 02:00–05:00（本地时间），一天一次；`force` 跳过窗口和"今天跑过"。
// - `dryRun` 全都不落库：归因只算不写、分流用不落库的 mind 重放、问题/梦/核实/自学都跳过
//   （它们没有 dryRun 入口，硬跑就会写事件或写表），最后也不写 nightly.last。
// - 任何一步抛错都只记进 `steps.x.error`，后面的照跑；跑完（非 dryRun）照常记"今天整理过"。
// - 状态记在旧库同一处：index.db 的 modes 表，`nightly.last`（毫秒）和 `nightly.<YYYY-MM-DD>`（'1'）。
import { attributePending } from './reflect.js'
import { createMind, userDomOf } from './split.js'
import { syncQuestions } from './questions.js'
import { dream } from './dream.js'
import { verifyDreams } from './verify.js'
import { dayOf } from './util.js'

export const NIGHTLY_WINDOW = ['02:00', '05:00']

const LAST_KEY = 'nightly.last'
const DAY_KEY = (day) => `nightly.${day}`

const whyOf = (e) => String(e?.message || e || '未知错误')

function kvGet(store, key) {
  if (typeof store?.modeGet === 'function') return store.modeGet(key)
  if (typeof store?.metaGet === 'function') return store.metaGet(key)
  return null
}

function kvSet(store, key, value) {
  if (typeof store?.modeSet === 'function') {
    store.modeSet(key, value)
    return
  }
  if (typeof store?.metaSet === 'function') store.metaSet(key, value)
}

/** "HH:MM" → 当天第几分钟；形状不对返回 null。 */
function minutesOf(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null
  return h * 60 + min
}

/**
 * 夜间流水线。store 是必填；model/learn 都可以没有；mind 可以注入（真跑时复用）。
 * 返回 { run, due, last, config }。
 */
export function createNightly({ store, log = () => {}, config = {}, model = null, learn = null, mind = null, roomAbsorb = null } = {}) {
  const cfg = {
    window: NIGHTLY_WINDOW,
    maxModelCalls: 40,
    minIntervalDays: 3,
    ...(config && typeof config === 'object' ? config : {}),
  }

  const windowMinutes = () => {
    const w = Array.isArray(cfg.window) && cfg.window.length >= 2 ? cfg.window : NIGHTLY_WINDOW
    const start = minutesOf(w[0]) ?? minutesOf(NIGHTLY_WINDOW[0])
    const end = minutesOf(w[1]) ?? minutesOf(NIGHTLY_WINDOW[1])
    return { start, end }
  }

  /** 窗口按本地时间算；两端都含（05:00 还在窗口里）；start > end 时按跨午夜处理。 */
  function inWindow(now) {
    const { start, end } = windowMinutes()
    const d = new Date(Number(now) || Date.now())
    const m = d.getHours() * 60 + d.getMinutes()
    if (start <= end) return m >= start && m <= end
    return m >= start || m <= end
  }

  /** 上次整理的时间（毫秒）；没跑过是 null。 */
  function last() {
    const raw = kvGet(store, LAST_KEY)
    const n = Number(raw)
    return raw == null || !Number.isFinite(n) ? null : n
  }

  function ranToday(now) {
    const day = dayOf(now)
    if (kvGet(store, DAY_KEY(day)) === '1') return true
    const prev = last()
    return prev != null && dayOf(prev) === day
  }

  function due({ now = Date.now() } = {}) {
    const at = Number(now) || Date.now()
    if (!inWindow(at)) return { ok: false, reason: '不在夜里' }
    if (ranToday(at)) return { ok: false, reason: '今天已经整理过' }
    return { ok: true }
  }

  /** 真跑：把这一趟新增的 attrib 行从表里捞出来（attributePending 只在 dryRun 回 rows）。 */
  function freshAttribRows(before) {
    return (store?.attribAll?.() || []).filter((r) => !before.has(Number(r?.seq)))
  }

  async function run({ now = Date.now(), force = false, dryRun = false } = {}) {
    const at = Number(now) || Date.now()
    const steps = {}

    if (!store) return { ok: false, ran: false, reason: '没有库', steps, at }

    // 窗口 / 一天一次：force 全跳过。
    if (!force) {
      const d = due({ now: at })
      if (!d.ok) return { ok: false, ran: false, reason: d.reason, steps, at }
    }

    // 1. 归因：规则先判，判不动才问模型；null 也算判过。
    let rows = []
    try {
      const before = new Set((store.attribAll?.() || []).map((r) => Number(r?.seq)))
      const r = await attributePending({
        store,
        model,
        maxModelCalls: cfg.maxModelCalls,
        log,
        now: at,
        dryRun,
      })
      rows = dryRun ? r.rows || [] : freshAttribRows(before)
      const { rows: _rows, ...rest } = r
      steps.reflect = { ok: true, ...rest }
    } catch (e) {
      steps.reflect = { ok: false, error: whyOf(e) }
    }

    // 2. 折进分流：dryRun 用不落库的 mind 从头重放（真实态可能已经有一半历史）。
    try {
      if (dryRun) {
        const m = createMind({ store: null, config: cfg, log })
        const seen = new Set()
        const all = [...(store.attribAll?.() || []), ...rows]
          .filter((r) => r && r.seq != null)
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .filter((r) => {
            const seq = Number(r.seq)
            if (seen.has(seq)) return false
            seen.add(seq)
            return true
          })
        m.replay(all, { now: at })
        steps.mind = { ok: true, dryRun: true, folded: rows.length, ...m.describe() }
      } else {
        const m = mind && typeof mind.fold === 'function' ? mind : createMind({ store, log, config: cfg })
        // 归因表里可能已经有几十条历史：按 seq 取"到这一条为止"的最近 20 条，算出 userDom 再传进去。
        // 不指望缓存里的 recentLabels（老缓存没有），否则升级后要等 20 条新归因才判得出主导度。
        const history = [...(store.attribAll?.() || [])].sort((a, b) => Number(a.seq) - Number(b.seq))
        let folded = 0
        for (const row of rows) {
          const upto = history.filter((r) => Number(r.seq) <= Number(row.seq))
          m.fold(row, { now: at, userDom: userDomOf(upto) })
          folded += 1
        }
        steps.mind = { ok: true, folded, ...m.describe() }
      }
    } catch (e) {
      steps.mind = { ok: false, error: whyOf(e) }
    }

    // 3. 同步问题清单：只补新的，不覆盖已答。
    try {
      if (dryRun) steps.questions = { ok: true, skipped: true, dryRun: true }
      else steps.questions = { ok: true, ...syncQuestions(store, { now: at }) }
    } catch (e) {
      steps.questions = { ok: false, error: whyOf(e) }
    }

    // 4. 做梦：节奏仍由 dream 自己管（force 只给人工入口，夜间不强制做梦）。
    try {
      if (dryRun) {
        steps.dream = { ok: true, skipped: true, dryRun: true }
      } else {
        const r = (await dream({
          store,
          model,
          now: at,
          force: false,
          minIntervalDays: cfg.minIntervalDays,
          log,
        })) || {}
        const { event, ...rest } = r
        steps.dream = { ...rest, ok: rest.ok === true, eventId: event?.id }
      }
    } catch (e) {
      steps.dream = { ok: false, error: whyOf(e) }
    }

    // 5. 核实：只记证据，不判应验。
    try {
      if (dryRun) {
        steps.verify = { ok: true, skipped: true, dryRun: true }
      } else {
        const r = (await verifyDreams({ store, now: at, log })) || {}
        steps.verify = { ...r, ok: true, pairs: Array.isArray(r.pairs) ? r.pairs.length : 0 }
      }
    } catch (e) {
      steps.verify = { ok: false, error: whyOf(e) }
    }

    // 6. 自学：注入的函数，没有就跳过。
    try {
      if (dryRun) steps.learn = { ok: true, skipped: true, dryRun: true }
      else if (typeof learn !== 'function') steps.learn = { ok: true, skipped: true }
      else {
        const r = await learn({ store, now: at })
        steps.learn = { ...(r && typeof r === 'object' ? r : {}), ok: r?.ok !== false }
      }
    } catch (e) {
      steps.learn = { ok: false, error: whyOf(e) }
    }

    // 7. 客厅吸收：从共享 room-log 进各自的库；判断由注入函数（index.js）决定。
    try {
      if (dryRun) steps.room = { ok: true, skipped: true, dryRun: true }
      else if (typeof roomAbsorb !== 'function') steps.room = { ok: true, skipped: true }
      else {
        const r = await roomAbsorb({ now: at })
        steps.room = { ...(r && typeof r === 'object' ? r : {}), ok: r?.ok !== false }
      }
    } catch (e) {
      steps.room = { ok: false, error: whyOf(e) }
    }

    // 跑完才记"今天整理过"；某一步失败也记——流水线确实跑过了，重跑用 force。
    if (!dryRun) {
      kvSet(store, LAST_KEY, at)
      kvSet(store, DAY_KEY(dayOf(at)), '1')
    }

    return { ok: true, ran: true, steps, at }
  }

  return { run, due, last, config: cfg }
}

export const nightly = createNightly
