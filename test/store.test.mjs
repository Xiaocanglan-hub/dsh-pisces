import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore, ZERO_HASH, hashOf, payloadOf } from '../lib/store.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-store-'))

async function seeded(opts = {}) {
  const root = tmp()
  const store = await createStore({ root, ...opts })
  const a = await store.append({ type: 'seed', text: '你不是助手。', source: 'system' })
  const b = await store.append({ type: 'utterance', text: '今天风大。', source: 'tool' })
  const c = await store.append({ type: 'meta', text: 'seen:2026-11-09', source: 'system', refs: [b.id] })
  return { root, store, a, b, c }
}

test('写入：id 带 ev_ 前缀、链能自证、refs 能指回', async () => {
  const { store, a, b, c } = await seeded({ forceJsonl: true })
  assert.match(a.id, /^ev_[0-9A-HJKMNP-TV-Z]{26}$/)
  assert.notEqual(a.id, b.id)
  assert.equal(a.prev_hash, ZERO_HASH)
  assert.equal(b.prev_hash, a.hash)
  assert.deepEqual(c.refs, [b.id])
  assert.equal(store.count(), 3)
  assert.deepEqual(store.verify(), { ok: true, count: 3, last: store.last().hash })
  store.close()
})

test('写入：不合法的直接抛，不落库', async () => {
  const { store } = await seeded({ forceJsonl: true })
  const before = store.count()
  await assert.rejects(() => store.append({ type: 'nope', text: 'x', source: 'tool' }), /事件不合法/)
  await assert.rejects(() => store.append({ type: 'meta', text: '', source: 'system' }), /正文不能为空/)
  assert.equal(store.count(), before)
  store.close()
})

test('链：sqlite 里改一条正文但不改 hash，verify 报 hash 对不上', async () => {
  const { root, store } = await seeded()
  if (store.backend !== 'sqlite') { store.close(); return }
  const { DatabaseSync } = await import('node:sqlite')
  store.close()
  const db = new DatabaseSync(path.join(root, 'events.db'))
  db.prepare('UPDATE events SET text = ? WHERE seq = 2').run('改过了。')
  db.close()
  const again = await createStore({ root })
  const v = again.verify()
  assert.equal(v.ok, false)
  assert.match(v.reason, /hash 对不上/)
  again.close()
})

test('链：老库（没有新记法标记）打开时重算一次，之后自证', async () => {
  const { root, store } = await seeded()
  if (store.backend !== 'sqlite') { store.close(); return }
  store.close()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(root, 'events.db'))
  db.exec("DELETE FROM meta WHERE k = 'hash_algo'")
  db.prepare('UPDATE events SET hash = ? WHERE seq = 3').run('0'.repeat(64))
  db.close()
  const logs = []
  const again = await createStore({ root, log: (...a) => logs.push(a.join(' ')) })
  assert.equal(again.verify().ok, true)
  assert.match(logs.join('\n'), /重算/)
  again.close()
})

test('日记：同一天覆盖、跨天保留；JSONL 降级也能用内存', async () => {
  const { store } = await seeded({ forceJsonl: true })
  assert.equal(store.diaryPut([{ day: '2026-11-09', text: '第一版' }]), 1)
  store.diaryPut([{ day: '2026-11-09', text: '第二版' }])
  store.diaryPut([{ day: 0, text: '第一天' }])
  const all = store.diaryAll()
  assert.equal(all.length, 2)
  assert.ok(all.some((d) => String(d.day) === '2026-11-09' && d.text === '第二版'))
  assert.ok(all.some((d) => String(d.day) === '0'))
  store.close()
})

test('hashOf：payload 形状固定，prev 参与计算', () => {
  const p = payloadOf({ id: 'ev_1', ts: 1, day: '2026-11-09', type: 'meta', text: 'x', refs: [], meta: {}, confidence: null, source: 'system' })
  assert.deepEqual(Object.keys(p), ['id', 'ts', 'day', 'type', 'text', 'refs', 'meta', 'confidence', 'source'])
  assert.notEqual(hashOf(ZERO_HASH, p), hashOf('f'.repeat(64), p))
})
