import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { attributePending } from '../lib/reflect.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-reflect-'))

async function seeded() {
  const root = tmp()
  const store = await createStore({ root, forceJsonl: true })
  await store.append({ type: 'seed', text: '起点', source: 'system' })
  await store.append({ type: 'utterance', text: '如果你现在走，我以后就不等了，因为等下去也没有结果。', source: 'tool' })
  await store.append({ type: 'utterance', text: '我有点难过。', source: 'tool' })
  await store.append({ type: 'utterance', text: '我把那句话记下来了，但没回，后来也没有再提起。', source: 'tool' })
  await store.append({ type: 'refusal', text: '我不想去那个群里说话。', source: 'tool' })
  await store.append({ type: 'meta', text: 'seen:x', source: 'system' })
  return { store }
}

test('归因跑批：规则先判，判不动的才问模型；meta 不进候选', async () => {
  const { store } = await seeded()
  const asked = []
  const model = { name: 'fake', ask: async (p) => { asked.push(p); return '{"label":"i","why":"凭感觉"}' } }
  const r = await attributePending({ store, model })
  assert.equal(r.candidates, 4)
  assert.ok(r.ruled >= 2)
  assert.equal(r.modeled, asked.length)
  assert.equal(r.failed, 0)
  const rows = store.attribAll()
  assert.equal(rows.length, r.ruled + r.modeled)
  assert.ok(rows.some((x) => x.label === 'd'))
  assert.ok(rows.some((x) => x.by === 'model'))
  assert.equal(rows.length, 4)
  store.close()
})

test('归因跑批：null 也算判过，第二遍 0 候选', async () => {
  const { store } = await seeded()
  const model = { name: 'fake', ask: async () => '{"label":"null"}' }
  const first = await attributePending({ store, model })
  assert.ok(first.written > 0)
  const second = await attributePending({ store, model })
  assert.equal(second.candidates, 0)
  assert.equal(second.written, 0)
  assert.equal(store.attribAll().length, first.written)
  store.close()
})

test('归因跑批：dryRun 只算不落库；没有模型时退成 null 而不是卡住', async () => {
  const { store } = await seeded()
  const dry = await attributePending({ store, model: null, dryRun: true })
  assert.equal(store.attribAll().length, 0)
  assert.equal(dry.written, 0)
  assert.ok(Array.isArray(dry.rows) && dry.rows.length > 0)

  const noModel = await attributePending({ store, model: null })
  assert.equal(noModel.failed, 0)
  assert.ok(noModel.written > 0)
  assert.ok(store.attribAll().every((r) => ['d', 'i', 'null'].includes(r.label)))
  store.close()
})

test('归因跑批：模型抛错不影响其余，失败计数 +1', async () => {
  const { store } = await seeded()
  const model = { name: 'bad', ask: async () => { throw new Error('ollama 挂了') } }
  const r = await attributePending({ store, model })
  assert.ok(r.failed >= 1)
  assert.equal(r.written, 4)
  store.close()
})

test('归因跑批：模型次数上限生效', async () => {
  const { store } = await seeded()
  let calls = 0
  const model = { name: 'fake', ask: async () => { calls += 1; return '{"label":"d"}' } }
  const r = await attributePending({ store, model, maxModelCalls: 1 })
  assert.equal(calls, 1)
  assert.equal(r.modelCalls, 1)
  store.close()
})

// 2026-11-11：宿主请求曾被当成他的话落库。heard 本来就不在候选类型里；
// 这里兜底别的类型/导入数据里整条都是注入块的情况——跳过，不判、不写 attrib。
test('归因跑批：整条宿主注入块不进候选', async () => {
  const root = tmp()
  const store = await createStore({ root, forceJsonl: true })
  await store.append({ type: 'seed', text: '起点', source: 'system' })
  await store.append({
    type: 'utterance',
    text: 'Generate the session title from this JSON array of human messages:\n[{"seq":9,"text":"想跟你说点什么，想不出来"}]',
    source: 'owner',
  })
  await store.append({
    type: 'utterance',
    text: '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
    source: 'owner',
  })

  const r = await attributePending({ store, model: null })
  assert.equal(r.candidates, 0)
  assert.equal(store.attribAll().length, 0)
  store.close()
})
