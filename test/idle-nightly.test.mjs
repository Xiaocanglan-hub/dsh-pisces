// 空闲整理（lib/idle-nightly.js）：纯函数判定 + 第二库"今天跑过"的口径。
//
// 口径（2026-11-14）：选项 3 + together、设置 pisces.idleNightly 开着、不在 02:00–05:00、
// 主库最后一条事件 ≥ 20 分钟、第二库今天没跑过、没有正在跑的 —— 全部满足才跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_QUIET_MS, ranNightlyToday, shouldRunIdle } from '../lib/idle-nightly.js'
import { NIGHTLY_WINDOW, inNightlyWindow } from '../lib/nightly.js'
import { dayOf } from '../lib/util.js'

const NOON = new Date(2026, 10, 9, 12, 0, 0).getTime()
const MIN = 60 * 1000

/** 假库：modeGet 直接读一个 Map，形状和真库一致。 */
function fakeStore(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    modeGet: (k) => (map.has(k) ? map.get(k) : null),
  }
}

test('idle-nightly：安静阈值是 20 分钟常量', () => {
  assert.equal(IDLE_QUIET_MS, 20 * 60 * 1000)
})

test('idle-nightly：全部满足才跑（纯函数）', () => {
  const r = shouldRunIdle({
    now: NOON,
    lastMainEventAt: NOON - 21 * MIN,
    alreadyRanToday: false,
    inWindow: false,
    busy: false,
    enabled: true,
  })
  assert.deepEqual(r, { ok: true })
})

test('idle-nightly：每个不满足的条件都拒绝，并给出原因', () => {
  const base = {
    now: NOON,
    lastMainEventAt: NOON - 21 * MIN,
    alreadyRanToday: false,
    inWindow: false,
    busy: false,
    enabled: true,
  }
  const cases = [
    [{ enabled: false }, /没开/],
    [{ busy: true }, /正在跑/],
    [{ inWindow: true }, /窗口/],
    [{ alreadyRanToday: true }, /今天/],
    [{ lastMainEventAt: null }, /取不到/],
    [{ lastMainEventAt: Number.NaN }, /取不到/],
    [{ lastMainEventAt: 0 }, /取不到/],
    [{ lastMainEventAt: NOON - 19 * MIN }, /不空闲/],
  ]
  for (const [patch, want] of cases) {
    const r = shouldRunIdle({ ...base, ...patch })
    assert.equal(r.ok, false, JSON.stringify(patch))
    assert.match(r.reason, want)
  }
})

test('idle-nightly：刚好 20 分钟算空闲；19 分 59 秒不算', () => {
  const base = { now: NOON, enabled: true }
  assert.equal(shouldRunIdle({ ...base, lastMainEventAt: NOON - IDLE_QUIET_MS }).ok, true)
  assert.equal(shouldRunIdle({ ...base, lastMainEventAt: NOON - IDLE_QUIET_MS + 1 }).ok, false)
})

test('idle-nightly：quietMs 可以被宿主配置覆盖（测试也用它）', () => {
  const base = { now: NOON, enabled: true }
  assert.equal(shouldRunIdle({ ...base, lastMainEventAt: NOON - 5 * MIN, quietMs: 5 * MIN }).ok, true)
  assert.equal(shouldRunIdle({ ...base, lastMainEventAt: NOON - 5 * MIN, quietMs: 10 * MIN }).ok, false)
  // 坏值退回常量。
  assert.equal(shouldRunIdle({ ...base, lastMainEventAt: NOON - 19 * MIN, quietMs: -1 }).ok, false)
})

test('idle-nightly：第二库"今天跑过"认 nightly.<day> 和 nightly.last 两种口径', () => {
  const today = dayOf(NOON)
  assert.equal(ranNightlyToday(fakeStore({ [`nightly.${today}`]: '1' }), NOON), true)
  assert.equal(ranNightlyToday(fakeStore({ 'nightly.last': String(NOON - MIN) }), NOON), true)
  assert.equal(ranNightlyToday(fakeStore({ 'nightly.last': String(NOON - 24 * 60 * MIN) }), NOON), false)
  assert.equal(ranNightlyToday(fakeStore({}), NOON), false)
  // 取不到库：当作没跑过（其它条件还会挡）。
  assert.equal(ranNightlyToday(null, NOON), false)
})

test('idle-nightly：夜间窗口两端都含，和主库 NIGHTLY_WINDOW 同一份', () => {
  assert.deepEqual(NIGHTLY_WINDOW, ['02:00', '05:00'])
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 1, 59).getTime()), false)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 2, 0).getTime()), true)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 4, 59).getTime()), true)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 5, 0).getTime()), true)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 5, 1).getTime()), false)
  // 自定义/坏窗口：坏值退回默认。
  assert.equal(inNightlyWindow(NOON, ['23:00', '01:00']), false)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 0, 30).getTime(), ['23:00', '01:00']), true)
  assert.equal(inNightlyWindow(new Date(2026, 10, 9, 3, 0).getTime(), ['bad', null]), true)
})
