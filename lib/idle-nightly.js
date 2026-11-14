// 空闲整理：主库真的闲着时，单独整理派希丝的第二个库。
//
// 为什么不是夜间窗口：第二库只在「选项 3 + 一起成长」时存在，夜里主库那一趟已经
// 跑满了（归因/梦/核实/自学）。再开一个窗口就是两个流水线抢模型、抢时间；所以这里
// 只在**主库确定空闲**的时候补一趟，跑的是同一套 createNightly，只是 store 换成
// banks/pisces、mind 换成她自己的。
//
// 判定抽成纯函数 shouldRunIdle：定时器只负责取数（主库最后事件时间、第二库今天跑过
// 没有、现在在不在主库夜间窗口里），跑不跑全看这一条。
import { dayOf } from './util.js'

/** 主库多久没动静算「空闲」：20 分钟。宿主 config 可用 pisces.idleQuietMs 覆盖。 */
export const IDLE_QUIET_MS = 20 * 60 * 1000

function kvGet(store, key) {
  if (typeof store?.modeGet === 'function') return store.modeGet(key)
  if (typeof store?.metaGet === 'function') return store.metaGet(key)
  return null
}

/**
 * 第二库今天整理过没有：和 createNightly 内部同一口径 —— modes 表里
 * `nightly.<YYYY-MM-DD>` = '1'，或 `nightly.last` 落在今天。
 * 取不到库就返回 false（当作没跑过；调用方还会再看别的条件）。
 */
export function ranNightlyToday(store, now = Date.now()) {
  const at = Number(now) || Date.now()
  if (kvGet(store, `nightly.${dayOf(at)}`) === '1') return true
  const raw = kvGet(store, 'nightly.last')
  const last = Number(raw)
  return raw != null && Number.isFinite(last) && dayOf(last) === dayOf(at)
}

/**
 * 空闲整理该不该跑。纯函数：不读文件、不取库、不写任何东西。
 *
 * 全部满足才跑：enabled（选项 3 且设置开着）、不在跑、不在主库夜间窗口、
 * 第二库今天没跑过、主库最后一条事件距今 ≥ quietMs。
 * 主库最后事件时间取不到（null/NaN/0）一律当「不空闲」，不猜。
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function shouldRunIdle({
  now = Date.now(),
  lastMainEventAt = null,
  alreadyRanToday = false,
  inWindow = false,
  busy = false,
  enabled = false,
  quietMs = IDLE_QUIET_MS,
} = {}) {
  const at = Number(now) || Date.now()
  if (!enabled) return { ok: false, reason: '没开（选项 3 + 单独整理开关）' }
  if (busy) return { ok: false, reason: '正在跑' }
  if (inWindow) return { ok: false, reason: '在主库夜间窗口内' }
  if (alreadyRanToday) return { ok: false, reason: '第二库今天已经整理过' }
  const last = Number(lastMainEventAt)
  if (lastMainEventAt == null || !Number.isFinite(last) || last <= 0) {
    return { ok: false, reason: '主库最后事件时间取不到' }
  }
  const quiet = Number(quietMs)
  const need = Number.isFinite(quiet) && quiet > 0 ? quiet : IDLE_QUIET_MS
  if (at - last < need) return { ok: false, reason: '主库不空闲' }
  return { ok: true }
}
