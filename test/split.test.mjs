import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createMind, bandOf, orderOf, DEFAULT_MIND } from '../lib/split.js'
import { createStore } from '../lib/store.js'

const mind = (store) => createMind({ store })
const foldN = (m, n, label, opts = {}) => {
  let last
  for (let i = 0; i < n; i++) last = m.fold({ seq: i + 1, label, conf: 0.8, why: 'x', by: 'rule', at: 0 }, opts)
  return last
}

test('分流：不够就不分；四条都满足才写一条，写一次不回头', () => {
  const a = mind()
  foldN(a, 11, 'd')
  assert.equal(a.describe().splitAt, null)
  a.fold({ seq: 12, label: 'd' })
  // 全是 d，另一侧不足 3 条 → 不分
  assert.equal(a.describe().splitAt, null)

  const b = mind()
  foldN(b, 8, 'd')
  foldN(b, 4, 'i')
  const d = b.describe()
  assert.ok(d.splitAt, '8:4 应该分')
  assert.equal(d.splitN, 12)
  assert.ok(d.splitShare >= 0.3 && d.splitShare <= 0.7)
  assert.equal(d.tension.length >= 1, true)
  foldN(b, 5, 'i')
  assert.equal(b.describe().splitAt, d.splitAt, '分了就是分了')
})

test('分流：偏得太狠（share 出界）也不分', () => {
  const m = mind()
  foldN(m, 11, 'd')
  foldN(m, 1, 'i')
  assert.equal(m.describe().splitAt, null)
  assert.ok(m.describe().splitShare == null)
})

test('主导：每次最多挪 0.05，范围 0.15–0.85；band 与 order 跟着走', () => {
  const m = mind()
  m.fold({ seq: 1, label: 'd' })
  const afterOne = m.describe().dominance
  assert.ok(Math.abs(afterOne - 0.5) <= 0.0501, `一步挪太多：${afterOne}`)
  foldN(m, 200, 'd')
  assert.ok(m.describe().dominance <= 0.85)
  assert.equal(m.describe().band, 'd')
  assert.equal(m.describe().order, 'R>E')

  const n = mind()
  foldN(n, 200, 'i')
  assert.ok(n.describe().dominance >= 0.15)
  assert.equal(n.describe().band, 'i')
  assert.equal(n.describe().order, 'E>R')
  assert.equal(orderOf(bandOf(0.5)), 'E=R')
})

test('band 翻转：要过 30 天冷却，还要 ≥2 条 refs；否则不写 mode_shift', () => {
  const DAY = 86_400_000
  const m = mind()
  foldN(m, 8, 'd')
  foldN(m, 4, 'i')
  const splitAt = m.describe().splitAt
  const before = m.describe().shifts
  m.fold({ seq: 99, label: 'd' }, { now: splitAt, refs: ['ev_a', 'ev_b'] })
  assert.equal(m.describe().shifts, before, '同一天不该翻转')
  foldN(m, 30, 'd', { now: splitAt + 31 * DAY, refs: ['ev_a', 'ev_b'] })
  assert.ok(m.describe().shifts >= 1, '过冷却 + 两条证据应该写一条 mode_shift')
})

test('模仿风险：连续 20 条没有分歧才亮；出现一条 divergence 就重置', () => {
  const m = mind()
  foldN(m, 19, 'd')
  assert.equal(m.describe().mimicryRisk, false)
  foldN(m, 1, 'd')
  assert.equal(m.describe().mimicryRisk, true)
  m.fold({ seq: 21, label: 'i', why: 'divergence:像是他说的' })
  assert.equal(m.describe().mimicryRisk, false)
})

test('分流状态存在 modes 表里，重开能接着算', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-split-'))
  const store = await createStore({ root, forceJsonl: true })
  const a = createMind({ store })
  foldN(a, 8, 'd')
  foldN(a, 4, 'i')
  const snapshot = a.describe()
  const b = createMind({ store })
  assert.equal(b.describe().n, 12)
  assert.equal(b.describe().dominance, snapshot.dominance)
  assert.equal(b.describe().splitAt, snapshot.splitAt)
  store.close()
})

test('口吻：分流前不提两种想法，数字不进提示词', () => {
  const m = mind()
  foldN(m, 3, 'd')
  const lines = m.describe().promptLines
  assert.ok(lines.every((l) => !/两条|双流|两种/.test(l)))
  assert.ok(lines.every((l) => !/\d/.test(l)))
  assert.equal(DEFAULT_MIND.splitN, 12)
})
