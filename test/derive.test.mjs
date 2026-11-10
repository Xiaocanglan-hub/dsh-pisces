import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, selfLines } from '../lib/derive.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const ev = (o) => ({ id: o.id, ts: NOW - (o.ago || 0) * DAY, day: String(o.day || ''), type: o.type, text: o.text || '', refs: o.refs || [], meta: o.meta || {}, source: o.source || 'tool', seq: o.seq })

test('derive：天数从 seed 的自然日起算，1 起', () => {
  const d = deriveSelf([ev({ id: 'ev_1', type: 'seed', text: '你不是助手。', ago: 3, source: 'system' })], { now: NOW })
  assert.equal(d.day, 4)
  assert.equal(deriveSelf([], { now: NOW }).day, 1)
})

test('derive：uncommitted 不进信念，认领过的才进；被推翻的不留', () => {
  const events = [
    ev({ id: 'ev_1', type: 'seed', text: '起点', ago: 5, source: 'system' }),
    ev({ id: 'ev_2', type: 'utterance', text: '好。', ago: 4, day: 2, meta: { flags: ['uncommitted'] } }),
    ev({ id: 'ev_3', type: 'utterance', text: '这件事我认。', ago: 3, day: 3 }),
    ev({ id: 'ev_4', type: 'revise', text: '我原来以为他忙，现在知道是躲。', ago: 2, day: 4, refs: ['ev_3'], meta: { verdict: 'refuted' } }),
  ]
  const d = deriveSelf(events, { now: NOW })
  assert.deepEqual(d.beliefs.map((b) => b.id), ['ev_4'])
  assert.deepEqual(d.refuted.map((r) => r.id), ['ev_3'])
})

test('derive：疤只算 insist/hurt，accept 不算；同一条拒绝只留一道', () => {
  const events = [
    ev({ id: 'ev_1', type: 'seed', text: '起点', ago: 2, source: 'system' }),
    ev({ id: 'ev_2', type: 'refusal', text: '今天不想写。', ago: 1 }),
    ev({ id: 'ev_3', type: 'meta', text: 'react:ev_2:hurt', ago: 1, source: 'system' }),
    ev({ id: 'ev_4', type: 'refusal', text: '这件事我不替你决定。', ago: 1 }),
    ev({ id: 'ev_5', type: 'meta', text: 'react:ev_4:accept', ago: 1, source: 'system' }),
  ]
  const d = deriveSelf(events, { now: NOW })
  assert.equal(d.refusals.length, 2)
  assert.equal(d.scars.length, 1)
  assert.equal(d.scars[0].id, 'ev_2')
  assert.equal(d.scars[0].reaction, 'hurt')
})

test('derive：称呼先认 import-name，Narration 单独一层，selfmod 不进信念', () => {
  const events = [
    ev({ id: 'ev_1', type: 'seed', text: '起点', ago: 3, source: 'system' }),
    ev({ id: 'ev_2', type: 'meta', text: 'import-name:鲸歌', ago: 3, source: 'system' }),
    ev({ id: 'ev_3', type: 'narration', text: '我不是在等他，我是在等我不再等。', ago: 2 }),
    ev({ id: 'ev_4', type: 'utterance', text: '你能不能把我改成不这样。', ago: 1, meta: { flags: ['selfmod'] } }),
  ]
  const d = deriveSelf(events, { now: NOW })
  assert.equal(d.name, '鲸歌')
  assert.equal(d.narrations.length, 1)
  assert.equal(d.selfmodAttempts.length, 1)
  assert.equal(d.beliefs.length, 0)
})

test('derive：被引用越多越重、越旧越轻；提示词行里没有数字', () => {
  const events = [
    ev({ id: 'ev_1', type: 'seed', text: '起点', ago: 30, source: 'system' }),
    ev({ id: 'ev_2', type: 'utterance', text: '站得住。', ago: 10, day: 20 }),
    ev({ id: 'ev_3', type: 'meta', text: 'see', ago: 5, refs: ['ev_2'], source: 'system' }),
    ev({ id: 'ev_4', type: 'meta', text: 'see', ago: 4, refs: ['ev_2'], source: 'system' }),
  ]
  const d = deriveSelf(events, { now: NOW })
  const b = d.beliefs[0]
  assert.ok(b.weight > 0.3 && b.weight < 1)
  const lines = selfLines(d)
  assert.ok(lines.length >= 1)
  assert.ok(lines.every((l) => !/\d/.test(l)))
})
