import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { search, tokenize, REPAIR_BOOST, REPAIR_MIN_OVERLAP } from '../lib/search.js'
import { classifyRepair, buildRepairWindow, REPAIR_WINDOW } from '../lib/repair.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-repair-'))
// 固定时间：分数里的 recency 是 now-ts 算的，不钉死就跑不出可复现的 golden。
const base = Date.UTC(2026, 10, 10, 12, 0, 0)
const DAY = 86_400_000

// ---- classifyRepair：只判「他这句是不是在纠正/追问」，0 模型调用 ----

test('修复分类：空 heard / 普通陈述 → none', () => {
  assert.deepEqual(classifyRepair({}), { need: 'none', targetRef: [], confidence: 0 })
  assert.deepEqual(
    classifyRepair({ heard: '', lastUtterance: '窗户关了一半。' }),
    { need: 'none', targetRef: [], confidence: 0 },
  )
  const r = classifyRepair({ heard: '今天风大。', lastUtterance: '窗户关了一半。' })
  assert.equal(r.need, 'none')
  assert.equal(r.confidence, 0)
})

test('修复分类：「他回来了吗」这类普通问句不触发', () => {
  const r = classifyRepair({ heard: '他回来了吗', lastUtterance: '今天风大。' })
  assert.equal(r.need, 'none')
  assert.deepEqual(r.targetRef, [])
})

test('修复分类：短疑问碎片（哪个？/你说的哪条？）→ clarify', () => {
  const a = classifyRepair({ heard: '哪个？', lastUtterance: '楼下那家面馆。' })
  assert.equal(a.need, 'clarify')
  assert.ok(a.confidence >= 0.4 && a.confidence <= 0.6, `confidence=${a.confidence}`)
  assert.ok(a.targetRef.includes('哪个'))
  const b = classifyRepair({ heard: '你说的哪条？', lastUtterance: '楼下那家面馆。' })
  assert.equal(b.need, 'clarify')
})

test('修复分类：显式纠正（我是说 / 你听错了）→ correct', () => {
  assert.equal(
    classifyRepair({ heard: '不是，我是说那家面馆。', lastUtterance: '今天风大。' }).need,
    'correct',
  )
  assert.equal(
    classifyRepair({ heard: '你听错了。', lastUtterance: '' }).need,
    'correct',
  )
  // 强势纠正即使开头是「不是啦」也不压：后面还有「我是说」。
  const r = classifyRepair({ heard: '不是啦，我是说那家店。', lastUtterance: '今天风大。' })
  assert.equal(r.need, 'correct')
  assert.ok(r.confidence >= 0.7)
})

test('修复分类：「不是啦今天好累」压分 → 不当成修复', () => {
  const r = classifyRepair({ heard: '不是啦今天好累', lastUtterance: '那就早点睡。' })
  assert.equal(r.need, 'none')
  assert.equal(r.confidence, 0)
})

test('修复分类：「哈哈」「……」压分 → none', () => {
  for (const heard of ['哈哈', '嘿嘿', '……']) {
    const r = classifyRepair({ heard, lastUtterance: '今天风大。' })
    assert.equal(r.need, 'none', `heard=${heard}`)
    assert.equal(r.confidence, 0, `heard=${heard}`)
  }
})

test('修复分类：与上一句 2-gram 重合 ≥2 → clarify', () => {
  const r = classifyRepair({
    heard: '窗户关了一半',
    lastUtterance: '窗关了一半，风还是从缝里进来。',
  })
  assert.equal(r.need, 'clarify')
  assert.ok(r.targetRef.includes('关了') || r.targetRef.includes('一半'), `targetRef=${r.targetRef}`)
})

test('修复分类：与上一句否定相反 → correct', () => {
  const r = classifyRepair({ heard: '不是我说的', lastUtterance: '是我说的' })
  assert.equal(r.need, 'correct')
})

test('修复分类：confidence 恒在 0..1，targetRef 是词数组', () => {
  const samples = [
    { heard: '哪个？', lastUtterance: '那家店。' },
    { heard: '你听错了', lastUtterance: '' },
    { heard: '不是啦今天好累', lastUtterance: '早点睡。' },
  ]
  for (const s of samples) {
    const r = classifyRepair(s)
    assert.ok(r.confidence >= 0 && r.confidence <= 1)
    assert.ok(Array.isArray(r.targetRef))
  }
})

// ---- buildRepairWindow：最近 N 条 heard/utterance → {seqs,tokens,weight} ----

test('修复窗口：取最近 N 条 heard/utterance，带 seq 与关键词', () => {
  const events = [
    { seq: 1, type: 'seed', text: '你不是助手。' },
    { seq: 2, type: 'utterance', text: '茶泡久了会苦。' },
    { seq: 3, type: 'heard', text: '窗户关了吗' },
    { seq: 4, type: 'meta', text: 'seen:1' },
    { seq: 5, type: 'utterance', text: '窗户关了一半。' },
  ]
  const win = buildRepairWindow({ events, heard: '窗户关了吗？', limit: 2 })
  assert.equal(win.seqs.has(5), true)
  assert.equal(win.seqs.has(3), true)
  assert.equal(win.seqs.has(1), false, 'seed 不算窗口')
  assert.equal(win.seqs.has(4), false, 'meta 不算窗口')
  assert.ok(win.tokens.has('窗户') || win.tokens.has('户关'))
  assert.equal(win.weight, REPAIR_BOOST)
  assert.equal(REPAIR_WINDOW, 3)
  assert.ok(['none', 'clarify', 'correct'].includes(win.need))
})

test('修复窗口：空窗口不报错，seqs/tokens 是空 Set', () => {
  for (const input of [{}, { events: [] }, { events: null }, { events: [{ seq: 1, type: 'seed', text: 'x' }] }]) {
    const win = buildRepairWindow(input)
    assert.equal(win.seqs.size, 0)
    assert.equal(win.tokens.size, 0, '没有窗口时不把 query 自己的词塞进来')
    assert.equal(win.weight, REPAIR_BOOST)
    assert.equal(win.need, 'none')
    assert.equal(win.confidence, 0)
  }
})

// ---- 检索：无 boostRef 与改动前逐条一致；有 boostRef 时目标条目排名上升 ----
// golden 是改 search.js 之前用同一份夹具跑出来的（day/text/score 三条查询），
// 用来钉住「没有修复窗口时，结果与改动前完全一致」。

async function goldenStore() {
  const root = tmp()
  const store = await createStore({ root, forceJsonl: true })
  const events = [
    { type: 'seed', text: '你不是助手。', ts: base - 9 * DAY },
    { type: 'utterance', text: '今天风大，窗户关了一半。', ts: base - 8 * DAY },
    { type: 'utterance', text: '茶泡久了会苦，下次少放一点。', ts: base - 7 * DAY },
    { type: 'refusal', text: '我不想去那个群里说话。', ts: base - 6 * DAY },
    { type: 'utterance', text: '他说楼下新开了家牛肉面馆，问我要不要去。', ts: base - 5 * DAY },
    { type: 'utterance', text: '我最近想吃那家牛肉面。', ts: base - 4 * DAY },
    { type: 'utterance', text: '窗关了一半，风还是从缝里进来。', ts: base - 3 * DAY },
    { type: 'utterance', text: '明天早点回来，别淋雨。', ts: base - 2 * DAY },
  ]
  for (const ev of events) await store.append({ source: 'tool', ...ev })
  return store
}

const GOLDEN = {
  窗户: {
    items: [{ day: '2026-11-02', type: 'utterance', text: '今天风大，窗户关了一半。', score: 1.753 }],
    total: 1,
  },
  牛肉面: {
    items: [
      { day: '2026-11-06', type: 'utterance', text: '我最近想吃那家牛肉面。', score: 2.642 },
      { day: '2026-11-05', type: 'utterance', text: '他说楼下新开了家牛肉面馆，问我要不要去。', score: 2.008 },
    ],
    total: 2,
  },
  早点: {
    items: [{ day: '2026-11-08', type: 'utterance', text: '明天早点回来，别淋雨。', score: 1.866 }],
    total: 1,
  },
}

test('检索：没有修复窗口时，结果与改动前逐条一致（golden）', async () => {
  const store = await goldenStore()
  for (const [query, expected] of Object.entries(GOLDEN)) {
    const got = search(store, { query, k: 5, budget: 800, now: base })
    const items = got.items.map(({ id, ...rest }) => rest)
    assert.deepEqual({ items, total: got.total }, expected, `query=${query}`)
  }
  store.close()
})

test('检索：空 boostRef 与不传 boostRef 完全一致', async () => {
  const store = await goldenStore()
  for (const query of Object.keys(GOLDEN)) {
    const plain = search(store, { query, k: 5, now: base })
    const empty = search(store, {
      query,
      k: 5,
      now: base,
      boostRef: { seqs: new Set(), tokens: new Set(), weight: REPAIR_BOOST },
    })
    assert.deepEqual(empty.items, plain.items, `query=${query}`)
    assert.equal(empty.total, plain.total)
  }
  store.close()
})

async function boostStore() {
  const root = tmp()
  const store = await createStore({ root, forceJsonl: true })
  // 竞争句更短、BM25 更高，但已在窗口外（后面还有两条 heard/utterance）；目标句在最近 3 条里。
  const competitor = await store.append({
    type: 'utterance',
    text: '我最近想吃那家牛肉面。',
    ts: base - 180 * DAY,
    source: 'tool',
  })
  await store.append({ type: 'utterance', text: '茶泡久了会苦。', ts: base - 20 * DAY, source: 'tool' })
  await store.append({ type: 'utterance', text: '明天早点回来，别淋雨。', ts: base - 10 * DAY, source: 'tool' })
  const target = await store.append({
    type: 'utterance',
    text: '他说楼下新开了家牛肉面馆，问我要不要去，还说汤头很浓，面也筋道。',
    ts: base - DAY,
    source: 'tool',
  })
  return { store, target, competitor }
}

test('检索：命中同一 seq → 目标条目排名上升，条数不变', async () => {
  const { store, target, competitor } = await boostStore()
  const before = search(store, { query: '牛肉面', k: 5, now: base })
  const beforeIdx = before.items.findIndex((x) => x.day === target.day)
  assert.equal(beforeIdx, 1, `目标原本排第二，实际 ${beforeIdx}`)

  const win = buildRepairWindow({ events: store.readAll(), heard: '牛肉面' })
  assert.equal(win.seqs.has(target.seq), true, '目标在最近窗口里')
  assert.equal(win.seqs.has(competitor.seq), false, '竞争条目在窗口外')
  const after = search(store, { query: '牛肉面', k: 5, now: base, boostRef: win })
  const afterIdx = after.items.findIndex((x) => x.day === target.day)

  assert.ok(afterIdx < beforeIdx, `排名应从 ${beforeIdx} 升到更前，实际 ${afterIdx}`)
  assert.equal(after.total, before.total, '只在已召回条目里重排，条数不变')
  assert.equal(after.items.length, before.items.length)
  const boosted = after.items.find((x) => x.day === target.day)
  const old = before.items[beforeIdx].score
  assert.ok(Math.abs(boosted.score - old * win.weight) <= 0.002, `加分应对齐 ×${win.weight}：${old} → ${boosted.score}`)
  store.close()
})

test('检索：高度重叠 token（不同 seq）→ 也能把目标条目抬上来', async () => {
  const { store, target } = await boostStore()
  const before = search(store, { query: '牛肉面', k: 5, now: base })
  const beforeIdx = before.items.findIndex((x) => x.day === target.day)
  assert.equal(beforeIdx, 1)

  // 窗口里放一条和目标同文、但 seq 不同的条目：只靠 token 覆盖命中（seq 集不参与）。
  const win = buildRepairWindow({
    events: [{ seq: 9999, type: 'utterance', text: target.text }],
    heard: '牛肉面',
  })
  assert.equal(win.seqs.has(9999), true)
  const tokensOnly = { seqs: new Set(), tokens: win.tokens, weight: REPAIR_BOOST }
  const after = search(store, { query: '牛肉面', k: 5, now: base, boostRef: tokensOnly })
  const afterIdx = after.items.findIndex((x) => x.day === target.day)
  assert.ok(afterIdx < beforeIdx, `token 重叠也应抬排名，${beforeIdx} → ${afterIdx}`)
  assert.equal(REPAIR_MIN_OVERLAP, 0.5)
  store.close()
})

test('检索：修复窗口不改变与窗口无关的条目分数', async () => {
  const { store } = await boostStore()
  const before = search(store, { query: '牛肉面', k: 5, now: base })
  const win = buildRepairWindow({
    events: [{ seq: 9999, type: 'utterance', text: '完全另一件事。' }],
    heard: '牛肉面',
  })
  const after = search(store, { query: '牛肉面', k: 5, now: base, boostRef: win })
  // 「完全另一件事」与牛肉面馆那条不重叠，分数应原样。
  const pick = (r) => r.items.map((x) => ({ day: x.day, score: x.score }))
  assert.deepEqual(pick(after), pick(before))
  store.close()
})
