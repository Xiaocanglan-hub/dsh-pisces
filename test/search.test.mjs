import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { tokenize, rebuildIndex, search, indexable, ensureIndex } from '../lib/search.js'

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

// ---- 2026-11-11：宿主请求曾被当成 heard 落库，读取侧不再翻出来 ----

test('索引：整条宿主注入块（标题生成 / system-reminder）不进索引', async () => {
  const { store } = await seeded()
  await store.append({
    type: 'heard',
    text: 'Generate the session title from this JSON array of human messages:\n[{"seq":9,"text":"窗户"}]',
    source: 'owner',
  })
  await store.append({
    type: 'heard',
    text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
    source: 'owner',
  })

  const r = rebuildIndex(store)
  assert.equal(r.docs, 4, 'seed + 2 utterance + refusal，注入块不计数')
  assert.equal(search(store, { query: 'session' }).items.length, 0)
  assert.equal(search(store, { query: 'skill' }).items.length, 0)
  store.close()
})

test('检索：旧索引里已经塞进去的注入块 → 跳过，不翻出来', async () => {
  const { store } = await seeded()
  rebuildIndex(store)
  const seq = 9001
  store.indexPut({
    docs: [{
      seq,
      id: 'ev_dirty',
      ts: Date.now(),
      day: '2026-11-11',
      type: 'heard',
      len: 72,
      importance: 0.5,
      text: 'Generate the session title from this JSON array of human messages:',
    }],
    terms: [{ term: 'generate', seq, tf: 1 }, { term: 'session', seq, tf: 1 }, { term: 'title', seq, tf: 1 }],
  })

  const found = search(store, { query: 'session' })
  assert.equal(found.items.length, 0, '历史脏文档被跳过')
  assert.equal(found.total, 0)
  store.close()
})

test('检索：他的话（heard）照常可检索，不被清洗误伤', async () => {
  const { store } = await seeded()
  await store.append({ type: 'heard', text: '他说今天早点回来。', source: 'owner' })
  rebuildIndex(store)

  const found = search(store, { query: '早点' })
  assert.equal(found.items.length, 1)
  assert.equal(found.items[0].type, 'heard')
  store.close()
})

// ---- 2026-11-11：索引只在空的时候重建过，重建之后说的话永远翻不到 ----

test('索引：重建之后 append 的新事件，不重建也能翻到', async () => {
  const { store } = await seeded()
  rebuildIndex(store)
  await store.append({ type: 'heard', text: '我最近想吃那家牛肉面。', source: 'owner' })

  const found = search(store, { query: '想吃' })
  assert.ok(found.items.some((x) => /牛肉面/.test(x.text)), `新说的一句应该翻得到，实际：${JSON.stringify(found.items.map((x) => x.text))}`)
  store.close()
})

test('索引：ensureIndex 只补新的，不重扫旧文档', async () => {
  const { store } = await seeded()
  rebuildIndex(store)
  const before = store.indexStats().docs
  await store.append({ type: 'heard', text: '窗户又没关。', source: 'owner' })
  const r = ensureIndex(store)
  assert.equal(r.docs, 1, '只补一条')
  assert.equal(store.indexStats().docs, before + 1)
  assert.equal(ensureIndex(store).docs, 0, '再调一次没有新东西')
  store.close()
})

// ---- 2026-11-12：长文靠长度通吃短句 + 他刚问的那句被当 heard 翻出来 ----

test('排名：一段长篇誊抄不再压过一句直接相关的话', async () => {
  const { store } = await seeded()
  const short = '我最近想吃那家牛肉面。'
  await store.append({ type: 'utterance', text: short, source: 'tool' })
  const longText = [
    '他让我把刚才那段话誊抄一遍，我就照做了。',
    '他说最近想吃牛肉面，我说知道了。',
    '后来我们又聊了茶、窗户，还有明天几点回来。',
    '窗外的风小了，茶也凉了，话题绕回来还是牛肉面。',
    '我记下了这件事，等下次再提。',
  ].join('\n').repeat(8)
  assert.ok(longText.length > 600, `长文长度：${longText.length}`)
  await store.append({ type: 'utterance', text: longText, source: 'tool' })
  rebuildIndex(store)

  const found = search(store, { query: '想吃牛肉面', k: 5 })
  assert.equal(found.items[0].text, short, `短句应排第一，实际：${JSON.stringify(found.items.map((x) => x.text.slice(0, 16)))}`)
})

test('检索：他刚问的那句（heard 回声）不再翻出来，相关的旧话还在', async () => {
  const { store } = await seeded()
  const echo = '我最近想吃那家牛肉面。'
  await store.append({ type: 'heard', text: echo, source: 'owner' })
  await store.append({ type: 'heard', text: '他说楼下新开了家牛肉面馆，问我要不要去。', source: 'owner' })
  rebuildIndex(store)

  const found = search(store, { query: echo })
  assert.equal(found.items.some((x) => x.text === echo), false, '与 query 几乎相同的 heard 被过滤')
  assert.ok(found.items.some((x) => /新开了家/.test(x.text)), `真正相关的旧话留下，实际：${JSON.stringify(found.items.map((x) => x.text.slice(0, 16)))}`)
  store.close()
})

test('检索：echo 过滤只针对 heard，她自己的 utterance 同句照常可翻', async () => {
  const { store } = await seeded()
  const same = '我最近想吃那家牛肉面。'
  await store.append({ type: 'utterance', text: same, source: 'tool' })
  rebuildIndex(store)

  const found = search(store, { query: same })
  assert.equal(found.items.some((x) => x.text === same), true, '她说过的同句仍算记忆')
  store.close()
})
