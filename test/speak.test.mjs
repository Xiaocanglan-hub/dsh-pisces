// 说话（lib/speak.js）：开关 → 校验 → 交给 bili.js。注入假 fetch，不连网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OWNER_FILE, REPLY_API, VIEW_API } from '../lib/bili.js'
import { SPEAK_MAX, speak, speakEnabled, validateSpeak } from '../lib/speak.js'

const BVID = 'BV1xx411c7mD'
const COOKIE = 'SESSDATA=sess-secret-value; bili_jct=csrf-token-123'
const OPEN = { bili: { speak: true } }

function mkRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-speak-'))
  writeFileSync(path.join(root, OWNER_FILE), JSON.stringify({ cookie: COOKIE }), 'utf8')
  return root
}

function fakeFetch(handler) {
  const calls = []
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    return handler(String(url), opts, calls.length)
  }
  fn.calls = calls
  return fn
}

const replyJson = (body) => ({ ok: true, status: 200, async json() { return body } })

test('speak：开关只认 cfg.bili.speak === true', () => {
  assert.equal(speakEnabled(), false)
  assert.equal(speakEnabled({}), false)
  assert.equal(speakEnabled({ bili: {} }), false)
  assert.equal(speakEnabled({ bili: { speak: 'true' } }), false)
  assert.equal(speakEnabled({ bili: { speak: 1 } }), false)
  assert.equal(speakEnabled({ bili: { speak: false } }), false)
  assert.equal(speakEnabled({ bili: { speak: true } }), true)
})

test('speak：开关关着就拒绝，一个请求都不发', async () => {
  const probe = fakeFetch(() => {
    throw new Error('没开时不该发请求')
  })
  const r = await speak({ root: mkRoot(), bvid: BVID, text: '在吗', cfg: {}, fetchImpl: probe })
  assert.deepEqual(r, { ok: false, reason: '说话功能没开' })
  assert.equal(probe.calls.length, 0)
})

test('speak：空正文 / 超 300 字 / bvid 不对都本地拒，不发请求', async () => {
  const probe = fakeFetch(() => {
    throw new Error('校验不过时不该发请求')
  })
  const root = mkRoot()

  assert.deepEqual(validateSpeak({ bvid: BVID, text: '' }), { ok: false, problems: ['没话可说'] })
  assert.deepEqual(validateSpeak({ bvid: BVID, text: '   ' }), { ok: false, problems: ['没话可说'] })
  assert.deepEqual(validateSpeak({ bvid: 'BV123', text: '在吗' }), {
    ok: false,
    problems: ['bvid 不像 bvid'],
  })
  assert.equal(validateSpeak({ bvid: BVID, text: '字'.repeat(SPEAK_MAX) }).ok, true)
  assert.equal(validateSpeak({ bvid: BVID, text: '字'.repeat(SPEAK_MAX + 1) }).ok, false)

  const empty = await speak({ root, bvid: BVID, text: '   ', cfg: OPEN, fetchImpl: probe })
  assert.deepEqual(empty, { ok: false, reason: '没话可说' })

  const long = await speak({
    root,
    bvid: BVID,
    text: '字'.repeat(SPEAK_MAX + 1),
    cfg: OPEN,
    fetchImpl: probe,
  })
  assert.deepEqual(long, { ok: false, reason: '太长了' })

  const badBvid = await speak({ root, bvid: 'BV1', text: '在吗', cfg: OPEN, fetchImpl: probe })
  assert.deepEqual(badBvid, { ok: false, reason: 'bvid 不像 bvid' })
  assert.equal(probe.calls.length, 0)
})

test('speak：正常时走到 postComment，先查 aid 再发那句话', async () => {
  const text = '今天风很大。'
  let replyCall = null
  const f = fakeFetch((url, opts) => {
    if (url.startsWith(VIEW_API)) return replyJson({ code: 0, data: { aid: 654321 } })
    if (url === REPLY_API) {
      replyCall = { url, opts }
      return replyJson({ code: 0, data: { rpid: 9 } })
    }
    throw new Error(`没想到的请求：${url}`)
  })
  const r = await speak({ root: mkRoot(), bvid: BVID, text, cfg: OPEN, fetchImpl: f })
  assert.deepEqual(r, { ok: true })
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[0].url.startsWith(VIEW_API))

  assert.ok(replyCall, '没有发出评论请求')
  const form = new URLSearchParams(replyCall.opts.body)
  assert.equal(form.get('oid'), '654321')
  assert.equal(form.get('type'), '1')
  assert.equal(form.get('message'), text)
  assert.equal(form.get('csrf'), 'csrf-token-123')
})

test('speak：失败 reason 是人话，不回显正文或 bvid', async () => {
  const text = '这句话不应该出现在失败理由里。'
  const f = fakeFetch((url) =>
    url.startsWith(VIEW_API)
      ? replyJson({ code: 0, data: { aid: 11 } })
      : replyJson({ code: -101, message: '账号未登录' }),
  )
  const r = await speak({ root: mkRoot(), bvid: BVID, text, cfg: OPEN, fetchImpl: f })
  assert.deepEqual(r, { ok: false, reason: '没登录' })
  assert.ok(!r.reason.includes(text))
  assert.ok(!r.reason.includes(BVID))

  // 连不上也不抛、不把正文带出来
  const boom = async () => {
    throw new Error(`offline ${text}`)
  }
  const r2 = await speak({ root: mkRoot(), bvid: BVID, text, cfg: OPEN, fetchImpl: boom })
  assert.equal(r2.ok, false)
  assert.ok(!r2.reason.includes(text))
  assert.ok(!r2.reason.includes(BVID))
})
