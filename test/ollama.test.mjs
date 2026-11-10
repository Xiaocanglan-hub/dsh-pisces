import test from 'node:test'
import assert from 'node:assert/strict'
import { createLocalModel, probeLocalModel } from '../lib/ollama.js'

test('ollama：POST /api/chat，body 带模型与非流式选项', async () => {
  const seen = []
  const fake = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ message: { content: '收到' } }) }
  }
  const m = createLocalModel({ model: 'qwen3:4b', baseUrl: 'http://127.0.0.1:11434/', fetchImpl: fake })
  const out = await m.ask('只回答：收到')
  assert.equal(out, '收到')
  assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(seen[0].body.model, 'qwen3:4b')
  assert.equal(seen[0].body.stream, false)
  assert.equal(seen[0].body.options.num_predict, 160)
})

test('ollama：非 2xx 抛错；探活失败不抛', async () => {
  const bad = async () => ({ ok: false, status: 500 })
  const m = createLocalModel({ fetchImpl: bad })
  await assert.rejects(() => m.ask('x'), /ollama 500/)
  const probe = await probeLocalModel({ fetchImpl: bad })
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /500/)
})
