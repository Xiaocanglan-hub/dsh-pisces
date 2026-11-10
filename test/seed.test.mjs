import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createMind } from '../lib/split.js'
import {
  BIASES,
  MAX_FRAGMENT,
  MAX_FRAGMENTS,
  MAX_TOTAL,
  initialDominance,
  seedOf,
  validateSeed,
  writeSeed,
} from '../lib/seed.js'

const fresh = async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-seed-'))
  return createStore({ root, forceJsonl: true })
}
const shut = (store) => {
  try {
    store.close()
  } catch {}
}
// 理由必须是能直接显示在面板上的人话：有中文、不像异常栈。
const isHuman = (reason) => {
  assert.equal(typeof reason, 'string')
  assert.ok(reason.length > 0)
  assert.match(reason, /[\u4e00-\u9fff]/, `理由不是中文：${reason}`)
  assert.ok(!/Error|undefined|null|ENOENT/.test(reason), `理由像异常：${reason}`)
}

test('起点上限：空 / 4 段 / 单段 201 字 / 合计 570 字都拒绝，理由是给人看的', async () => {
  const empty = validateSeed([])
  assert.equal(empty.ok, false)
  assert.equal(empty.fragments.length, 0)
  assert.equal(empty.chars, 0)
  assert.match(empty.problems.join('；'), /空/)

  // 空白段先丢掉，再数段数
  const blank = validateSeed(['  ', '\n', '\t'])
  assert.equal(blank.ok, false)
  assert.equal(blank.fragments.length, 0)

  const four = validateSeed(['一', '二', '三', '四'])
  assert.equal(four.ok, false)
  assert.match(four.problems.join('；'), /3 段/)
  assert.equal(four.problems.length, 1, '4 段只该报超段数')

  const long = validateSeed(['字'.repeat(MAX_FRAGMENT + 1)])
  assert.equal(long.ok, false)
  assert.match(long.problems.join('；'), /太长/)
  assert.match(long.problems.join('；'), new RegExp(String(MAX_FRAGMENT)))

  const wide = validateSeed(['字'.repeat(190), '字'.repeat(190), '字'.repeat(190)])
  assert.equal(wide.ok, false)
  assert.equal(wide.chars, 570)
  assert.match(wide.problems.join('；'), new RegExp(String(MAX_TOTAL)))
  assert.equal(wide.problems.length, 1, '每段都不超，只该报合计')

  // 正好踩线：3 段 × 200 字 = 600 > 500 仍拒绝；2 段 × 200 = 400 放行
  assert.equal(validateSeed(['字'.repeat(200), '字'.repeat(200), '字'.repeat(200)]).ok, false)
  const fit = validateSeed(['字'.repeat(200), '字'.repeat(200)])
  assert.equal(fit.ok, true)
  assert.equal(fit.chars, 400)

  // 校验不通过时 writeSeed 也不落库
  const store = await fresh()
  const r = await writeSeed({ store, texts: ['一', '二', '三', '四'] })
  assert.equal(r.ok, false)
  isHuman(r.reason)
  assert.ok(Array.isArray(r.problems) && r.problems.length >= 1)
  assert.equal(store.count(), 0)
  shut(store)
})

test('写一次：事件形状对，正文是段间空行连接', async () => {
  const store = await fresh()
  const ts = 1_700_000_000_000
  const r = await writeSeed({ store, texts: ['第一段。', '   ', '第二段。'], bias: 'balanced', now: ts })
  assert.equal(r.ok, true)
  assert.equal(r.chars, '第一段。'.length + '第二段。'.length)
  assert.deepEqual(r.fragments, ['第一段。', '第二段。'])

  const ev = r.event
  assert.equal(ev.type, 'seed')
  assert.equal(ev.source, 'owner')
  assert.equal(ev.text, '第一段。\n\n第二段。')
  assert.equal(ev.ts, ts)
  assert.match(ev.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(ev.meta.kind, 'owner-seed')
  assert.deepEqual(ev.meta.fragments, ['第一段。', '第二段。'])
  assert.equal(ev.meta.chars, r.chars)
  assert.equal(ev.meta.bias, 'balanced')
  assert.equal(ev.meta.dominance, 0.5)

  const all = store.readAll()
  assert.equal(all.length, 1)
  assert.equal(all[0].type, 'seed')
  assert.equal(all[0].source, 'owner')
  assert.deepEqual(all[0].meta.fragments, ['第一段。', '第二段。'])
  assert.equal(seedOf(all)?.id, ev.id)
  shut(store)
})

test('只写一次：第二次拒绝，事件流不多一条', async () => {
  const store = await fresh()
  const first = await writeSeed({ store, texts: ['我是谁。'] })
  assert.equal(first.ok, true)
  const before = store.count()

  const second = await writeSeed({ store, texts: ['改成别人。'] })
  assert.equal(second.ok, false)
  assert.match(second.reason, /已经有起点了/)
  isHuman(second.reason)
  assert.equal(store.count(), before)
  assert.equal(store.readAll()[0].text, '我是谁。')
  shut(store)
})

test('导入来的起点也算：source:migration 的 seed 挡住写入', async () => {
  const store = await fresh()
  await store.append({
    type: 'seed',
    source: 'migration',
    text: '从鱼那边带过来的起点',
    meta: { kind: 'import-seed', bias: 'intuitive' },
  })
  const r = await writeSeed({ store, texts: ['再来一次'] })
  assert.equal(r.ok, false)
  assert.match(r.reason, /已经有起点了/)
  isHuman(r.reason)
  assert.equal(store.count(), 1)
  shut(store)
})

test('偏向：写进 seed.meta 的 bias/dominance；乱填的偏向直接拒绝', async () => {
  assert.deepEqual(
    BIASES.map((b) => [b.id, b.dominance]),
    [
      ['balanced', 0.5],
      ['rational', 0.65],
      ['intuitive', 0.35],
    ],
  )

  const store = await fresh()
  const r = await writeSeed({ store, texts: ['先把边界算清楚。'], bias: 'rational' })
  assert.equal(r.ok, true)
  assert.equal(r.event.meta.bias, 'rational')
  assert.equal(r.event.meta.dominance, 0.65)

  const store2 = await fresh()
  const bad = await writeSeed({ store: store2, texts: ['随便写点什么'], bias: 'genius' })
  assert.equal(bad.ok, false)
  isHuman(bad.reason)
  assert.match(bad.reason, /偏向/)
  assert.equal(store2.count(), 0, '偏向非法不许落库')
  shut(store)
  shut(store2)
})

test('偏向决定初始主导：0.65 / 0.35 / 0.5', async () => {
  const cases = [
    ['rational', 0.65],
    ['intuitive', 0.35],
    ['balanced', 0.5],
  ]
  for (const [bias, want] of cases) {
    const store = await fresh()
    const wrote = await writeSeed({ store, texts: [`我是 ${bias}`], bias })
    assert.equal(wrote.ok, true)
    const start = initialDominance(store.readAll())
    assert.equal(start, want, `${bias} 的初始主导`)
    const m = createMind({ store, startDominance: start })
    assert.equal(m.describe().dominance, want)
    shut(store)
  }
})

test('没有起点时是 0.5；起点没写偏向也退回 0.5', async () => {
  assert.equal(initialDominance([]), 0.5)
  assert.equal(initialDominance(), 0.5)
  assert.equal(seedOf([]), null)
  assert.equal(seedOf([{ type: 'utterance' }]), null)

  const store = await fresh()
  await store.append({ type: 'seed', source: 'migration', text: '导入的起点，没写偏向' })
  const start = initialDominance(store.readAll())
  assert.equal(start, 0.5)
  assert.equal(createMind({ store, startDominance: start }).describe().dominance, 0.5)

  const noSeed = createMind({ store: await fresh(), startDominance: initialDominance([]) })
  assert.equal(noSeed.describe().dominance, 0.5)
  shut(store)
})

test('有缓存就按缓存：startDominance 只在没有状态时生效', async () => {
  const store = await fresh()
  const a = createMind({ store })
  a.fold({ seq: 1, label: 'd', conf: 0.8, why: 'x', by: 'rule', at: 0 })
  const cached = a.describe().dominance
  assert.ok(Math.abs(cached - 0.55) < 1e-9, `一步应该挪到 0.55，实际 ${cached}`)

  const b = createMind({ store, startDominance: 0.8 })
  assert.equal(b.describe().dominance, cached, '缓存里的主导不能被传入值盖掉')
  assert.notEqual(b.describe().dominance, 0.8)
  shut(store)
})
