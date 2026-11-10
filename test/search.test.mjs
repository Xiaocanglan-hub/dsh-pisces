import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { tokenize, rebuildIndex, search, indexable } from '../lib/search.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-search-'))

async function seeded() {
  const root = tmp()
  const store = await createStore({ root, forceJsonl: true })
  await store.append({ type: 'seed', text: '你不是助手。', source: 'system' })
  await store.append({ type: 'utterance', text: '今天风大，窗户关了一半。', source: 'tool' })
  await store.append({ type: 'utterance', text: '茶泡久了会苦，下次少放一点。', source: 'tool' })
  await store.append({ type: 'meta', text: 'seen:2026-11-09', source: 'system' })
  await store.append({ type: 'refusal', text: '我不想去那个群里说话。', source: 'tool' })
  return { root, store }
}

test('分词：中文二元组、英文词、短句单字', () => {
  const t = tokenize('窗户关了 BV18Bx')
  assert.ok(t.includes('窗关') || t.includes('窗户'))
  assert.ok(t.includes('关了'))
  assert.ok(t.includes('bv18bx'))
  assert.deepEqual(tokenize(''), [])
})

test('索引：meta 不进索引；重建后能按词翻回去', async () => {
  const { store } = await seeded()
  assert.equal(indexable({ type: 'meta', text: 'x' }), false)
  const r = rebuildIndex(store)
  assert.ok(r.docs >= 3)
  assert.ok(r.terms > 0)
  const found = search(store, { query: '窗户', k: 5, budget: 800 })
  assert.equal(found.items.length >= 1, true)
  assert.match(found.items[0].text, /窗户/)
  assert.ok(found.ms >= 0)
  store.close()
})

test('检索：空查询返回空；k 与预算生效；不存在的词返回空', async () => {
  const { store } = await seeded()
  rebuildIndex(store)
  assert.deepEqual(search(store, { query: '' }).items, [])
  assert.equal(search(store, { query: '窗户' }).items.length <= 8, true)
  const one = search(store, { query: '窗户', k: 1 })
  assert.equal(one.items.length, 1)
  assert.deepEqual(search(store, { query: '量子纠缠' }).items, [])
  store.close()
})
