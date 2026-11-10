// import：从 dsh-fish 搬家——ISO 时间戳、refs 分流、verdict/flags、日记、幂等、清单。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { importFishEvents, importFishDiary, importFishRoot } from '../lib/import.js'

const ISO = '2026-11-09T12:58:17.217Z'
const MS = Date.parse(ISO)

// 两个根必须分开：store 的 JSONL 降级也写 <root>/events.jsonl，
// 跟假 fish 目录混在一起的话，第二次读到的就是 store 自己的行（测试会假阳/假阴）。
async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-import-'))
  const fish = path.join(root, 'fish')
  mkdirSync(fish, { recursive: true })
  return { root, fish, store: await createStore({ root: path.join(root, 'store'), forceJsonl: true }) }
}

/** 行可以是对象，也可以是坏 JSON 字符串（专门用来测坏行）。 */
function writeEvents(dir, rows) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'events.jsonl')
  writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n', 'utf8')
  return file
}

const byId = (store, id) => store.readAll().find((e) => String(e.id) === String(id))

test('ISO 时间戳转毫秒；坏时间戳计 badTs，并用上一行的时间兜底', async () => {
  const { fish, store } = await mkStore()
  const file = writeEvents(fish, [
    { id: 'ev_t1', type: 'utterance', ts: ISO, text: '第一句。' },
    { id: 'ev_t2', type: 'utterance', ts: '不是时间', text: '第二句。' },
    { id: 'ev_t3', type: 'utterance', ts: '2026-11-09T13:00:00.500Z', text: '第三句。' },
    { id: 'ev_t4', type: 'utterance', ts: '', text: '第四句。' },
  ])
  const r = await importFishEvents({ file, store })

  assert.equal(r.imported, 4)
  assert.equal(r.badTs, 2)
  assert.equal(r.failed, 0)
  const all = store.readAll()
  assert.equal(all[0].ts, MS)
  assert.equal(all[1].ts, MS) // 上一行的
  assert.equal(all[2].ts, Date.parse('2026-11-09T13:00:00.500Z'))
  assert.equal(all[3].ts, all[2].ts) // 还是上一行的
  for (const e of all) assert.ok(Number.isFinite(e.ts) && e.ts > 1_700_000_000_000, `${e.id} 的时间是 ${e.ts}`)
  assert.equal(r.chain.ok, true)
  store.close()
})

test('基本搬运：5 条全部 imported，source=migration，id / 正文 / 时间一致', async () => {
  const { fish, store } = await mkStore()
  const rows = [
    { id: 'ev_a', type: 'utterance', ts: ISO, text: '我说一句。' },
    { id: 'ev_b', type: 'narration', ts: '2026-11-09T13:00:00.000Z', text: '窗外还在下雨。' },
    { id: 'ev_c', type: 'heard', ts: '2026-11-09T13:01:00.000Z', text: '他说他明天来。' },
    { id: 'ev_d', type: 'voice', ts: '2026-11-09T13:02:00.000Z', text: '视频里的人说你好。' },
    { id: 'ev_e', type: 'meta', ts: '2026-11-09T13:03:00.000Z', text: 'seen:2026-11-09' },
  ]
  const file = writeEvents(fish, rows)
  const r = await importFishEvents({ file, store })

  assert.equal(r.read, 5)
  assert.equal(r.imported, 5)
  assert.equal(r.skipped, 0)
  assert.equal(r.failed, 0)
  assert.equal(r.firstId, 'ev_a')
  assert.equal(r.lastId, 'ev_e')
  assert.equal(store.count(), 5)
  assert.deepEqual(r.chain, { ok: true, count: 5, last: store.last().hash })

  for (const row of rows) {
    const ev = byId(store, row.id)
    assert.ok(ev, `少了 ${row.id}`)
    assert.equal(ev.type, row.type)
    assert.equal(ev.text, row.text)
    assert.equal(ev.ts, Date.parse(row.ts))
    assert.equal(ev.source, 'migration')
    assert.equal(ev.confidence, null)
  }
  store.close()
})

test('refs 分流：ev_… 进 refs；BV 号 / 外链进 meta.foreignRefs，不被校验拒', async () => {
  const { fish, store } = await mkStore()
  const file = writeEvents(fish, [
    {
      id: 'ev_v1',
      type: 'voice',
      ts: ISO,
      text: '视频里的人说：你看这个角度。',
      refs: ['ev_src', 'BV1xx411c7mD', 'https://b23.tv/abcd'],
    },
    { id: 'ev_h1', type: 'heard', ts: '2026-11-09T13:05:00.000Z', text: '视频里有人说话。', refs: ['BV1yy411c7mE'] },
  ])
  const r = await importFishEvents({ file, store })

  assert.equal(r.imported, 2) // 照抄 refs 的话这两条会被 validateEvent 拒
  assert.equal(r.failed, 0)
  const v = byId(store, 'ev_v1')
  assert.deepEqual(v.refs, ['ev_src'])
  assert.deepEqual(v.meta.foreignRefs, ['BV1xx411c7mD', 'https://b23.tv/abcd'])
  const h = byId(store, 'ev_h1')
  assert.deepEqual(h.refs, [])
  assert.deepEqual(h.meta.foreignRefs, ['BV1yy411c7mE'])
  store.close()
})

test('verdict / flags（含 uncommitted）/ fishDay 进 meta，confidence 原样带', async () => {
  const { fish, store } = await mkStore()
  const file = writeEvents(fish, [
    {
      id: 'ev_r1',
      type: 'revise',
      ts: ISO,
      text: '那句我收回，我没那么想。',
      refs: ['ev_old'],
      verdict: 'refined',
      flags: ['uncommitted', 'selfmod'],
      day: 3,
      confidence: 0.8,
    },
  ])
  const r = await importFishEvents({ file, store })
  assert.equal(r.imported, 1)

  const ev = byId(store, 'ev_r1')
  assert.equal(ev.meta.verdict, 'refined')
  assert.deepEqual(ev.meta.flags, ['uncommitted', 'selfmod'])
  assert.ok(ev.meta.flags.includes('uncommitted'))
  assert.equal(ev.meta.fishDay, 3)
  assert.equal(ev.confidence, 0.8)
  assert.equal(ev.source, 'migration')
  assert.deepEqual(ev.refs, ['ev_old'])
  store.close()
})

test('未知类型跳过并计 unknownType，不硬塞进事件流', async () => {
  const { fish, store } = await mkStore()
  const file = writeEvents(fish, [
    { id: 'ev_1', type: 'utterance', ts: ISO, text: '一。' },
    { id: 'ev_2', type: 'mystery', ts: '2026-11-09T13:00:00.000Z', text: '没有这个类型。' },
    { id: 'ev_3', type: 'seed', ts: '2026-11-09T13:01:00.000Z', text: '你不是助手。' },
    { id: 'ev_4', type: 'dream', ts: '2026-11-09T13:02:00.000Z', text: '（梦）' },
    { id: 'ev_5', type: 'grant', ts: '2026-11-09T13:03:00.000Z', text: '他答应我。' },
  ])
  const r = await importFishEvents({ file, store })

  assert.equal(r.read, 5)
  assert.equal(r.imported, 4)
  assert.equal(r.skipped, 1)
  assert.equal(r.unknownType, 1)
  assert.equal(r.failed, 0)
  assert.equal(store.count(), 4)
  assert.equal(store.readAll().some((e) => e.type === 'mystery'), false)
  assert.equal(r.chain.ok, true)
  store.close()
})

test('幂等：同一份导两次，第二次 imported=0、skipped=N，事件流不翻倍、链仍 ok', async () => {
  const { fish, store } = await mkStore()
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `ev_i${i + 1}`,
    type: 'utterance',
    ts: Date.parse(ISO) + i * 60_000,
    text: `第 ${i + 1} 句。`,
  }))
  const file = writeEvents(fish, rows)

  const first = await importFishEvents({ file, store })
  assert.equal(first.imported, 5)
  assert.equal(store.count(), 5)

  const second = await importFishEvents({ file, store })
  assert.equal(second.imported, 0)
  assert.equal(second.skipped, 5)
  assert.equal(second.failed, 0)
  assert.equal(second.badTs, 0)
  assert.equal(store.count(), 5) // 没有翻倍
  assert.deepEqual(second.chain, { ok: true, count: 5, last: store.last().hash })
  store.close()
})

test('日记：两个 md → diaryPut 两天，原文一字不改；再导一次 skipped=2', async () => {
  const { fish, store } = await mkStore()
  mkdirSync(path.join(fish, 'diary'), { recursive: true })
  const d1 = '第一天的日记\r\n第二行\n'
  const d2 = '最后一天。原文一字不改，包括  空格与标点！\n'
  writeFileSync(path.join(fish, 'diary', '2026-11-06.md'), d1, 'utf8')
  writeFileSync(path.join(fish, 'diary', '2026-11-09.md'), d2, 'utf8')

  const first = await importFishDiary({ dir: fish, store })
  assert.deepEqual(first, { read: 2, imported: 2, skipped: 0 })
  const rows = store.diaryAll()
  assert.equal(rows.length, 2)
  assert.equal(rows.find((x) => x.day === '2026-11-06').text, d1)
  assert.equal(rows.find((x) => x.day === '2026-11-09').text, d2)

  const second = await importFishDiary({ dir: fish, store })
  assert.deepEqual(second, { read: 2, imported: 0, skipped: 2 })
  assert.equal(store.diaryAll().length, 2)
  store.close()
})

test('importFishRoot 返回合并清单：count / firstId / lastId / chain.ok', async () => {
  const { fish, store } = await mkStore()
  writeEvents(fish, [
    { id: 'ev_a1', type: 'seed', ts: ISO, text: '你不是助手。' },
    { id: 'ev_a2', type: 'utterance', ts: '2026-11-09T13:00:00.000Z', text: '我在。' },
    { id: 'ev_a3', type: 'meta', ts: '2026-11-09T13:10:00.000Z', text: 'seen:2026-11-09' },
  ])
  mkdirSync(path.join(fish, 'diary'), { recursive: true })
  writeFileSync(path.join(fish, 'diary', '2026-11-07.md'), '搬家那天。', 'utf8')

  const r = await importFishRoot({ dir: fish, store })
  assert.equal(r.events.imported, 3)
  assert.equal(r.diary.imported, 1)
  assert.equal(r.count, 4)
  assert.equal(r.firstId, 'ev_a1')
  assert.equal(r.lastId, 'ev_a3')
  assert.equal(r.chain.ok, true)
  assert.equal(r.chain.count, 3)
  assert.equal(store.count(), 3)
  assert.deepEqual(store.diaryAll().map((d) => d.day), ['2026-11-07'])
  store.close()
})

test('坏 JSON 行只计 failed 与 samples，不影响后面的行和链', async () => {
  const { fish, store } = await mkStore()
  const file = writeEvents(fish, [
    { id: 'ev_ok1', type: 'utterance', ts: ISO, text: '前面的。' },
    '{"id": "ev_broken", "type": ',
    { id: 'ev_ok2', type: 'utterance', ts: '2026-11-09T13:20:00.000Z', text: '后面的。' },
  ])
  const r = await importFishEvents({ file, store })

  assert.equal(r.read, 3)
  assert.equal(r.imported, 2)
  assert.equal(r.failed, 1)
  assert.equal(r.samples.length, 1)
  assert.equal(r.samples[0].id, null)
  assert.match(r.samples[0].error, /JSON/)
  assert.equal(store.count(), 2)
  assert.equal(r.chain.ok, true)
  store.close()
})
