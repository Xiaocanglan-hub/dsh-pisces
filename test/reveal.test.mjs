// 状态面板的渐进揭开：深度只算领养之后，档位两把尺子任一达到即升。
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeReveal, maskState, MASKED_FIELDS, REVEAL_LEVELS } from '../lib/reveal.js'

const NOW = Date.parse('2026-11-10T12:00:00+08:00')
const DAY = 86_400_000

const demo = (ts = NOW - 1000, seq = 1) => ({
  id: 'ev_demo',
  seq,
  ts,
  type: 'meta',
  text: 'demo:adult',
  meta: { kind: 'demo', name: '派希丝' },
})

const say = (i, ts = NOW) => ({
  id: `ev_${i}`,
  seq: 2 + i,
  ts: ts + i,
  type: 'utterance',
  text: `第 ${i} 句。`,
})

const assertAllLocked = (locked) => {
  for (const name of MASKED_FIELDS) assert.equal(locked[name], true, `${name} 应该是遮住的`)
}

test('深度 0：六档里的 L0，除名字/身份外全遮，下一档还差 2 次或 1 天', () => {
  // 门槛表与需求表一致：六档、事件数或天数任一达到即可。
  assert.deepEqual(
    REVEAL_LEVELS.map((lv) => [lv.level, lv.minEvents, lv.minDays]),
    [
      [0, 0, 0],
      [1, 2, 1],
      [2, 6, 2],
      [3, 14, 4],
      [4, 28, 7],
      [5, 50, 14],
      [6, 80, 30],
    ],
  )

  const events = [demo(), { id: 'ev_seen', seq: 2, ts: NOW, type: 'meta', text: 'seen:x', meta: {} }]
  const r = computeReveal({ events, now: NOW })

  assert.equal(r.level, 0)
  assert.equal(r.depth, 0) // meta 类（demo 标记、seen）不算交流
  assert.equal(r.days, 0)
  assert.equal(r.baselineSeq, 1)
  assertAllLocked(r.locked)
  assert.deepEqual(r.next, { level: 1, needEvents: 2, needDays: 1 })
})

test('加 2 条：L1 揭开「存在天数」，事件数还遮着', () => {
  const r = computeReveal({ events: [demo(), say(1), say(2)], now: NOW })

  assert.equal(r.depth, 2)
  assert.equal(r.level, 1)
  assert.equal(r.locked.day, false)
  assert.equal(r.locked.events, true)
  assert.equal(r.locked.attribution, true)
  assert.deepEqual(r.next, { level: 2, needEvents: 4, needDays: 2 })
})

test('加 6 条：L2 再揭开「事件数」，归因/主导仍遮', () => {
  const events = [demo(), ...[1, 2, 3, 4, 5, 6].map((i) => say(i))]
  const r = computeReveal({ events, now: NOW })

  assert.equal(r.depth, 6)
  assert.equal(r.level, 2)
  assert.equal(r.locked.day, false)
  assert.equal(r.locked.events, false)
  assert.equal(r.locked.order, true)
  assert.equal(r.locked.attribution, true)
  assert.deepEqual(r.next, { level: 3, needEvents: 8, needDays: 4 })
})

test('加 14 条：L3 揭开归因分布与主导 order，悬着的问题仍遮', () => {
  const events = [demo(), ...Array.from({ length: 14 }, (_, i) => say(i + 1))]
  const r = computeReveal({ events, now: NOW })

  assert.equal(r.depth, 14)
  assert.equal(r.level, 3)
  assert.equal(r.locked.attribution, false)
  assert.equal(r.locked.order, false)
  assert.equal(r.locked.dominance, false)
  assert.equal(r.locked.openQuestions, true)
  assert.deepEqual(r.next, { level: 4, needEvents: 14, needDays: 7 })
})

test('天数判据：一条新交流都没有、只过 1 天，也揭开「存在天数」', () => {
  const r = computeReveal({ events: [demo(NOW - DAY)], now: NOW })

  assert.equal(r.depth, 0)
  assert.equal(r.days, 1)
  assert.equal(r.level, 1)
  assert.equal(r.locked.day, false)
  assert.equal(r.locked.events, true)
  assert.equal(r.next.level, 2)
})

test('普通鱼没有 demo 基线 → 返回 null；空事件流同理', () => {
  assert.equal(computeReveal({ events: [], now: NOW }), null)
  assert.equal(
    computeReveal({
      events: [
        { id: 'ev_seed', seq: 1, ts: NOW - DAY, type: 'seed', text: '三句话', meta: {} },
        { ...say(1), meta: {} },
      ],
      now: NOW,
    }),
    null,
  )
  // 只有字面上像 demo、但没写 meta.kind 的事件，也不认。
  assert.equal(
    computeReveal({ events: [{ id: 'ev_x', seq: 1, ts: NOW, type: 'meta', text: 'demo:adult', meta: {} }], now: NOW }),
    null,
  )
})

test('maskState：返回遮好的新对象，不改原对象；没有被锁的字段保持原值', () => {
  const state = {
    ok: true,
    day: 3,
    events: 7,
    order: 'R>E',
    dominance: 0.65,
    band: 'd',
    attribution: { d: 1, i: 1, null: 1, total: 3 },
    openQuestions: 1,
    dreams: 1,
    verified: 1,
    refusals: 4,
    scars: 2,
    demo: { name: '派希丝', label: '起点那句话' },
    recent: [{ id: 'ev_1' }],
  }
  const reveal = computeReveal({ events: [demo()], now: NOW })
  const masked = maskState(state, reveal)

  assert.notEqual(masked, state)
  assert.equal(masked.reveal, reveal)
  assert.equal(masked.demo, state.demo) // 名字/身份永远不遮
  assert.deepEqual(masked.recent, state.recent)
  for (const name of MASKED_FIELDS) {
    assert.equal(masked[name], null, `${name} 应该是 null`)
    assert.equal(masked.masked[name], true, `${name} 应该标 masked`)
  }
  assert.equal(masked.band, null) // band 是 dominance 折出来的，跟着一起遮

  // 原对象一个字段都没被改。
  assert.equal(state.day, 3)
  assert.equal(state.events, 7)
  assert.deepEqual(state.attribution, { d: 1, i: 1, null: 1, total: 3 })
  assert.equal(state.band, 'd')
  assert.equal(state.masked, undefined)
  assert.equal(state.reveal, undefined)

  // 非成年鱼传 null：原样返回，行为与现在一致。
  assert.equal(maskState(state, null), state)
})
