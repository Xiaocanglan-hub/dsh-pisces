// verify：梦之后找证据、只记证据不判应验、同一个梦只核一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import {
  bigrams,
  overlap,
  verifyDreams,
  observedLines,
  VERIFY_WINDOW_DAYS,
  VERIFY_MAX_AGE_DAYS,
  MIN_OVERLAP,
} from '../lib/verify.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-verify-'))
  return createStore({ root, forceJsonl: true })
}

async function addEvent(store, input) {
  const back = await store.append(input)
  return store.readAll().find((e) => String(e.id) === String(back.id))
}

function addDream(store, { hypothesis, ts, status = 'untested' }) {
  return addEvent(store, {
    type: 'dream_sim',
    text: `（梦）${hypothesis}`,
    meta: { thread: hypothesis, threadKey: 'k', hypothesis, status },
    source: 'system',
    ts,
  })
}

function addEvidence(store, { text, ts, type = 'utterance' }) {
  return addEvent(store, { type, text, meta: {}, source: 'owner', ts })
}

const observedEvents = (store) =>
  store.readAll().filter((e) => e.type === 'meta' && e.meta?.kind === 'dream_observed')

test('bigrams：中文二元组去标点空白；overlap 去重', () => {
  const g = bigrams('猫为什么会踩奶')
  for (const x of ['猫为', '为什', '什么', '么会', '会踩', '踩奶']) {
    assert.ok(g.includes(x), `缺二元组 ${x}`)
  }
  assert.equal(g.length, 6)
  assert.deepEqual(bigrams('猫，为什么 会踩奶！'), g, '标点空白不参与二元组')

  assert.deepEqual(overlap('猫为什么会踩奶', '他问猫为什么会踩奶？'), [
    '猫为',
    '为什',
    '什么',
    '么会',
    '会踩',
    '踩奶',
  ])
  assert.deepEqual(overlap('猫为猫为', '猫为猫为'), ['猫为', '为猫'], '共有二元组去重')

  assert.equal(VERIFY_WINDOW_DAYS, 14)
  assert.equal(VERIFY_MAX_AGE_DAYS, 30)
  assert.equal(MIN_OVERLAP, 2)
})

test('命中：梦之后 3 天的 utterance 重合 ≥2 → 写 dream_observed，refs 指向梦与证据', async () => {
  const store = await mkStore()
  const dream = await addDream(store, { hypothesis: '猫为什么会踩奶', ts: NOW - 5 * DAY })
  // 下面的 meta 正文也重合，但类型不算证据；不能因为它而提前命中。
  await addEvidence(store, { type: 'meta', text: '猫为什么会踩奶', ts: NOW - 4 * DAY })
  const later = await addEvidence(store, {
    text: '我最近总想起猫为什么会踩奶。',
    ts: NOW - 1 * DAY,
  })
  const earliest = await addEvidence(store, {
    text: '猫为什么会踩奶呢？',
    ts: NOW - 3 * DAY,
  })

  const out = await verifyDreams({ store, now: NOW })
  assert.equal(out.scanned, 1)
  assert.equal(out.verified, 1)
  assert.equal(out.skipped, 0)
  assert.equal(out.pairs.length, 1)
  assert.equal(out.pairs[0].dream.id, dream.id)
  assert.equal(out.pairs[0].evidence.id, earliest.id, '取最早命中的那条，不是最后写入的')
  assert.equal(out.pairs[0].hypothesis, '猫为什么会踩奶')

  const metas = observedEvents(store)
  assert.equal(metas.length, 1)
  const ev = metas[0]
  assert.equal(ev.type, 'meta')
  assert.equal(ev.text, 'dream_observed')
  assert.deepEqual(ev.refs, [dream.id, earliest.id])
  assert.equal(ev.meta.kind, 'dream_observed')
  assert.equal(ev.meta.dream, dream.id)
  assert.equal(ev.meta.evidence, earliest.id)
  assert.deepEqual(ev.meta.overlap, ['猫为', '为什', '什么', '么会', '会踩', '踩奶'])
  assert.equal('confirmed' in ev.meta, false, '不判应验：不写 confirmed')
  assert.equal('refuted' in ev.meta, false, '不判应验：不写 refuted')
  assert.equal(ev.status, undefined, '状态也不写进事件本身')
  assert.notEqual(later.id, earliest.id)
  store.close()
})

test('不命中：重合只有 1 个 → 不写', async () => {
  const store = await mkStore()
  await addDream(store, { hypothesis: '猫为什么会踩奶', ts: NOW - 2 * DAY })
  await addEvidence(store, { text: '猫踩奶的样子很可爱。', ts: NOW - 1 * DAY })

  const out = await verifyDreams({ store, now: NOW })
  assert.equal(out.scanned, 1)
  assert.equal(out.verified, 0)
  assert.deepEqual(out.pairs, [])
  assert.equal(observedEvents(store).length, 0)
  store.close()
})

test('梦之前的事不算：证据 ts 早于 dream.ts → 不写', async () => {
  const store = await mkStore()
  await addDream(store, { hypothesis: '猫为什么会踩奶', ts: NOW - 2 * DAY })
  await addEvidence(store, { text: '猫为什么会踩奶呢？', ts: NOW - 3 * DAY })

  const out = await verifyDreams({ store, now: NOW })
  assert.equal(out.verified, 0)
  assert.equal(observedEvents(store).length, 0)
  store.close()
})

test('同一个梦第二次调用不再写；太老的梦（>30 天）skipped', async () => {
  const store = await mkStore()
  const dream = await addDream(store, { hypothesis: '猫为什么会踩奶', ts: NOW - 2 * DAY })
  await addEvidence(store, { text: '猫为什么会踩奶呢？', ts: NOW - 1 * DAY })

  const first = await verifyDreams({ store, now: NOW })
  assert.equal(first.verified, 1)

  const second = await verifyDreams({ store, now: NOW })
  assert.equal(second.verified, 0, '同一个梦只核一次')
  assert.equal(observedEvents(store).length, 1, '不重复写事件')

  // 太老的梦：31 天前；证据在窗口内也不再核。
  const old = await addDream(store, { hypothesis: '他是不是还在楼下等', ts: NOW - 31 * DAY })
  await addEvidence(store, { text: '我想他是不是还在楼下等。', ts: NOW - 30 * DAY })

  const third = await verifyDreams({ store, now: NOW })
  assert.equal(third.verified, 0)
  assert.equal(third.skipped, 1)
  assert.equal(observedEvents(store).length, 1)
  assert.equal(observedEvents(store).some((e) => e.meta.dream === old.id), false)
  assert.equal(observedEvents(store)[0].meta.dream, dream.id)
  store.close()
})

test('observedLines：返回 {hypothesis, evidence} 配对，最多 limit 条', async () => {
  const store = await mkStore()
  await addDream(store, { hypothesis: '猫为什么会踩奶', ts: NOW - 10 * DAY })
  await addEvidence(store, { text: '她说猫为什么会踩奶，大概是小时候。', ts: NOW - 9 * DAY })
  await addDream(store, { hypothesis: '他是不是还在楼下等', ts: NOW - 6 * DAY })
  await addEvidence(store, { text: '我想他是不是还在楼下等。', ts: NOW - 5 * DAY })

  await verifyDreams({ store, now: NOW })

  const all = observedLines(store)
  assert.deepEqual(all, [
    { hypothesis: '猫为什么会踩奶', evidence: '她说猫为什么会踩奶，大概是小时候。' },
    { hypothesis: '他是不是还在楼下等', evidence: '我想他是不是还在楼下等。' },
  ])
  assert.deepEqual(Object.keys(all[0]).sort(), ['evidence', 'hypothesis'])

  assert.deepEqual(observedLines(store, { limit: 1 }), [
    { hypothesis: '他是不是还在楼下等', evidence: '我想他是不是还在楼下等。' },
  ])
  assert.deepEqual(observedLines(store, { limit: 0 }), [])
  store.close()
})
