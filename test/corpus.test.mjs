// 语料测量：切句、六个量、空输入安全。
import test from 'node:test'
import assert from 'node:assert/strict'
import { measure, sentences } from '../lib/corpus.js'

test('corpus：切句与短句比例', () => {
  const ss = sentences('好。今天有点累，不太想说话。')
  assert.deepEqual(ss, ['好', '今天有点累，不太想说话'])
  const m = measure(['好。今天有点累，不太想说话。'])
  assert.equal(m.n, 1)
  assert.equal(m.sentences, 2)
  assert.equal(m.shortPct, 50)
})

test('corpus：语气词 / 盖章 / 结构都能量到', () => {
  const m = measure(['嗯，我记下了。不是不想，而是累了。'])
  assert.ok(m.particlePer1k > 0)
  assert.ok(m.receiptPer1k > 0)
  assert.ok(m.structurePer1k > 0)
})

test('corpus：空输入安全', () => {
  const m = measure(['', null, undefined, '   '])
  assert.equal(m.n, 0)
  assert.equal(m.chars, 0)
  assert.equal(m.cv, 0)
})
