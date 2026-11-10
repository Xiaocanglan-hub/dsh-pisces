// 好感（lib/affinity.js）：只从事件流推导，不落库、不新增计数器表。
//
// 这一份测的是口径本身：初始 10、每天 +0.5（封顶 +15）、各类互动的加减、冷落衰减、
// clamp、分档边界、nextAt、答过的问题加分、以及"机器事件不加好感"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeAffinity, maskAffinity, tierOf, reactionOf } from '../lib/affinity.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const ev = (o) => ({
  id: o.id,
  ts: o.ts != null ? o.ts : NOW - (o.ago || 0) * DAY,
  day: String(o.day || ''),
  type: o.type,
  text: o.text || '',
  refs: o.refs || [],
  meta: o.meta || {},
  source: o.source || 'tool',
  seq: o.seq,
})

const heard = (n, ago = 0) =>
  Array.from({ length: n }, (_, i) => ev({ id: `ev_h${i}`, type: 'heard', text: '他说了一句。', ago }))

test('空库 → 10 分、0 档、陌生；nextAt 是 20', () => {
  const a = computeAffinity({ events: [], now: NOW })
  assert.deepEqual(a, { value: 10, tier: 0, label: '陌生', nextAt: 20, days: 0, earned: 0, lost: 0 })
})

test('10 条 heard → +15（1.5 一条），落在眼熟档', () => {
  const a = computeAffinity({ events: heard(10), now: NOW })
  assert.equal(a.earned, 15)
  assert.equal(a.value, 25)
  assert.equal(a.tier, 1)
  assert.equal(a.label, '眼熟')
  assert.equal(a.nextAt, 40)
})

test('react：hurt 扣 6、insist 扣 3；拒绝本身不扣', () => {
  const base = [ev({ id: 'ev_r1', type: 'refusal', text: '这件事我不答应。' })]
  const hurt = computeAffinity({
    events: [...base, ev({ id: 'ev_re1', type: 'meta', text: 'react:ev_r1:hurt', meta: { kind: 'react', reaction: 'hurt' } })],
    now: NOW,
  })
  assert.equal(hurt.lost, 6)
  assert.equal(hurt.value, 4)

  const insist = computeAffinity({
    events: [...base, ev({ id: 'ev_re2', type: 'meta', text: 'react:ev_r1:insist', meta: { kind: 'react', reaction: 'insist' } })],
    now: NOW,
  })
  assert.equal(insist.lost, 3)
  assert.equal(insist.value, 7)

  // accept / leave 不算伤，refusal 本身不扣。
  const accept = computeAffinity({
    events: [...base, ev({ id: 'ev_re3', type: 'meta', text: 'react:ev_r1:accept', meta: { kind: 'react', reaction: 'accept' } })],
    now: NOW,
  })
  assert.equal(accept.lost, 0)
  assert.equal(reactionOf(ev({ id: 'x', type: 'meta', text: 'react:ev_r1:leave', meta: { kind: 'react', reaction: 'leave' } })), null)
})

test('冷落：超过 7 天每天 -1（最多 -10）；正好 7 天不扣', () => {
  const cold = computeAffinity({
    events: [
      ev({ id: 'ev_1', type: 'seed', text: '起点', ago: 20, source: 'system' }),
      ev({ id: 'ev_2', type: 'utterance', text: '今天有点累。', ago: 10 }),
    ],
    now: NOW,
  })
  assert.equal(cold.days, 20)
  assert.equal(cold.lost, 3) // 10 - 7
  assert.equal(cold.value, 17.5) // 10 + (15 封顶 + 0.5) - 3

  const exactly7 = computeAffinity({ events: [ev({ id: 'ev_3', type: 'utterance', text: '嗯。', ago: 7 })], now: NOW })
  assert.equal(exactly7.lost, 0)

  // 20 天不互动也只扣到 -10。
  const veryCold = computeAffinity({ events: [ev({ id: 'ev_4', type: 'utterance', text: '嗯。', ago: 40 })], now: NOW })
  assert.equal(veryCold.lost, 10)
})

test('clamp：上限 100、下限 0；每天加分封顶 +15', () => {
  const up = computeAffinity({
    events: Array.from({ length: 30 }, (_, i) => ev({ id: `ev_u${i}`, type: 'reunion', text: '又见面了。', ago: 0 })),
    now: NOW,
  })
  assert.equal(up.value, 100)
  assert.equal(up.tier, 4)

  const down = computeAffinity({
    events: Array.from({ length: 5 }, (_, i) => ev({ id: `ev_d${i}`, type: 'meta', text: 'react:r:hurt', meta: { kind: 'react', reaction: 'hurt' }, ago: 0 })),
    now: NOW,
  })
  assert.equal(down.value, 0)

  // 90 天共同存在：+15 封顶，不会一直涨（加一条今天的互动，免得算冷落）。
  const longLived = computeAffinity({
    events: [
      ev({ id: 'ev_seed', type: 'seed', text: '起点', ago: 90, source: 'system' }),
      ev({ id: 'ev_today', type: 'utterance', text: '今天有点累。' }),
    ],
    now: NOW,
  })
  assert.equal(longLived.days, 90)
  assert.equal(longLived.earned, 15.5) // 15（封顶）+ 0.5
  assert.equal(longLived.lost, 0)
  assert.equal(longLived.value, 25.5)
})

test('分档边界：19/20、39/40、59/60、79/80', () => {
  assert.deepEqual(tierOf(19), { tier: 0, label: '陌生', nextAt: 20 })
  assert.deepEqual(tierOf(20), { tier: 1, label: '眼熟', nextAt: 40 })
  assert.deepEqual(tierOf(39), { tier: 1, label: '眼熟', nextAt: 40 })
  assert.deepEqual(tierOf(40), { tier: 2, label: '亲近', nextAt: 60 })
  assert.deepEqual(tierOf(59), { tier: 2, label: '亲近', nextAt: 60 })
  assert.deepEqual(tierOf(60), { tier: 3, label: '依赖', nextAt: 80 })
  assert.deepEqual(tierOf(79), { tier: 3, label: '依赖', nextAt: 80 })
  assert.deepEqual(tierOf(80), { tier: 4, label: '离不开', nextAt: null })
  assert.deepEqual(tierOf(100), { tier: 4, label: '离不开', nextAt: null })
})

test('nextAt 是下一档门槛，满档是 null', () => {
  assert.equal(computeAffinity({ events: [], now: NOW }).nextAt, 20)
  assert.equal(computeAffinity({ events: heard(10), now: NOW }).nextAt, 40)
  const full = computeAffinity({
    events: Array.from({ length: 30 }, (_, i) => ev({ id: `ev_f${i}`, type: 'reunion', text: '又见面了。', ago: 0 })),
    now: NOW,
  })
  assert.equal(full.tier, 4)
  assert.equal(full.nextAt, null)
})

test('答过的问题每条 +2，最多 +10；没答的不算', () => {
  const qs = (answered, open) => [
    ...Array.from({ length: answered }, (_, i) => ({ key: `a${i}`, status: 'answered' })),
    ...Array.from({ length: open }, (_, i) => ({ key: `o${i}`, status: 'open' })),
  ]
  const three = computeAffinity({ events: [], questions: qs(3, 4), now: NOW })
  assert.equal(three.earned, 6)
  assert.equal(three.value, 16)

  const many = computeAffinity({ events: [], questions: qs(8, 0), now: NOW })
  assert.equal(many.earned, 10) // 8 × 2 = 16，但封顶 10
  assert.equal(many.value, 20)
})

test('meta / seen: / dream_observed / card_patch 不加好感，也不算"最后一条互动"', () => {
  const machineOnly = computeAffinity({
    events: [
      ev({ id: 'ev_m1', type: 'meta', text: 'seen:abc', ago: 0, meta: { kind: 'seen' } }),
      ev({ id: 'ev_m2', type: 'meta', text: 'dream_observed', ago: 0, meta: { kind: 'dream_observed' } }),
      ev({ id: 'ev_m3', type: 'card_patch', text: '改了一张卡。', ago: 0, meta: { kind: 'card_patch', decision: 'applied' } }),
      ev({ id: 'ev_m4', type: 'meta', text: 'demo:adult', ago: 0, meta: { kind: 'demo', name: '派希丝' } }),
    ],
    now: NOW,
  })
  assert.equal(machineOnly.earned, 0)
  assert.equal(machineOnly.value, 10)

  // 机器事件（seen:）不能把"冷落"清零：最后一条真人互动还是 10 天前。
  const stillCold = computeAffinity({
    events: [
      ev({ id: 'ev_6', type: 'utterance', text: '今天有点累。', ago: 10 }),
      ev({ id: 'ev_7', type: 'meta', text: 'seen:zzz', ago: 0, meta: { kind: 'seen' } }),
    ],
    now: NOW,
  })
  assert.equal(stillCold.lost, 3)
  assert.equal(stillCold.value, 12.5) // 10 + (5 天分 + 0.5) - 3
})

test('遮罩：level < 2 只藏数字，心意（tier/label/nextAt）照给', () => {
  const aff = computeAffinity({ events: heard(10), now: NOW })
  const masked = maskAffinity(aff, 0)
  assert.equal(masked.value, null)
  assert.equal(masked.earned, null)
  assert.equal(masked.lost, null)
  assert.equal(masked.masked, true)
  assert.equal(masked.tier, aff.tier)
  assert.equal(masked.label, aff.label)
  assert.equal(masked.nextAt, aff.nextAt)

  const opened = maskAffinity(aff, 2)
  assert.equal(opened.value, aff.value)
  assert.equal(opened.masked, false)
  // 不遮时也带 masked:false，面板据此判断。
  assert.deepEqual(maskAffinity(aff, Infinity), { ...aff, masked: false })
})
