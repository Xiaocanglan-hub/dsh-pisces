// B 站（lib/bili.js）：只读热门 + 在视频下说一句。
// 全部注入假 fetch，测试绝不连网；owner.json 写在临时目录里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  OWNER_FILE,
  POPULAR_API,
  REPLY_API,
  VIEW_API,
  bvidToAid,
  hot,
  postComment,
  readOwner,
} from '../lib/bili.js'

const BVID = 'BV1xx411c7mD'
const COOKIE = 'SESSDATA=sess-secret-value; bili_jct=csrf-token-123'
const TEXT = '这句话很短。'

/** 临时根目录；传 owner 对象/字符串就写 owner.json，传 undefined 就不写。 */
function mkRoot(owner) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-bili-'))
  if (owner !== undefined) {
    const body = typeof owner === 'string' ? owner : JSON.stringify(owner)
    writeFileSync(path.join(root, OWNER_FILE), body, 'utf8')
  }
  return root
}

/** 假 fetch：记录每次请求，交给 handler 决定返回。 */
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

test('bili：readOwner 只认 owner.json 里同时有 SESSDATA 与 bili_jct', () => {
  // 没有文件
  assert.equal(readOwner(mkRoot()), null)
  // 缺 bili_jct
  assert.equal(readOwner(mkRoot({ cookie: 'SESSDATA=abc' })), null)
  // 坏 JSON
  assert.equal(readOwner(mkRoot('{ 这不是 JSON')), null)

  const root = mkRoot({ cookie: COOKIE })
  const owner = readOwner(root)
  assert.deepEqual(owner, { cookie: COOKIE, csrf: 'csrf-token-123' })
  assert.deepEqual(Object.keys(owner).sort(), ['cookie', 'csrf'])
})

test('bili：bvid 形状不对就不发请求；正常时 URL 带 bvid 并返回 aid', async () => {
  const probe = fakeFetch(() => {
    throw new Error('形状不对时不该发请求')
  })
  assert.deepEqual(await bvidToAid('BV123', { fetchImpl: probe }), {
    ok: false,
    reason: 'bvid 不像 bvid',
  })
  assert.equal(probe.calls.length, 0)

  const f = fakeFetch((url) => {
    assert.ok(url.startsWith(VIEW_API), `不该请求 ${url}`)
    assert.equal(new URL(url).searchParams.get('bvid'), BVID)
    return replyJson({ code: 0, data: { aid: 987654321 } })
  })
  assert.deepEqual(await bvidToAid(BVID, { fetchImpl: f }), { ok: true, aid: 987654321 })
  assert.equal(f.calls.length, 1)
})

test('bili：hot 解析 bvid/title/owner/view，limit 生效，接口非 0 就 ok:false', async () => {
  const f = fakeFetch((url) => {
    assert.equal(url, POPULAR_API)
    return replyJson({
      code: 0,
      data: {
        list: [
          { bvid: 'BV1xx411c7mD', title: '第一个', owner: { name: 'UP甲' }, stat: { view: 100 } },
          { bvid: 'BV1xx411c7mE', title: '第二个', owner: { name: 'UP乙' }, stat: { view: 200 } },
          { bvid: 'BV1xx411c7mF', title: '第三个', owner: { name: 'UP丙' }, stat: { view: 300 } },
        ],
      },
    })
  })
  const r = await hot({ limit: 2, fetchImpl: f })
  assert.equal(r.ok, true)
  assert.equal(r.items.length, 2)
  assert.deepEqual(r.items[0], {
    bvid: 'BV1xx411c7mD',
    title: '第一个',
    owner: 'UP甲',
    view: 100,
  })
  assert.equal(f.calls.length, 1)

  const bad = fakeFetch(() => replyJson({ code: -412, message: '风控' }))
  const rb = await hot({ fetchImpl: bad })
  assert.equal(rb.ok, false)
  assert.match(rb.reason, /-412/)
})

test('bili：没登录 / cookie 不完整 / 没话可说 / 太长 都在本地拒，不连网', async () => {
  const f = fakeFetch(() => {
    throw new Error('前置拒绝不该发请求')
  })

  const noFile = mkRoot()
  assert.deepEqual(await postComment({ root: noFile, bvid: BVID, text: TEXT, fetchImpl: f }), {
    ok: false,
    reason: '没登录',
  })

  const noJct = mkRoot({ cookie: 'SESSDATA=abc' })
  assert.deepEqual(await postComment({ root: noJct, bvid: BVID, text: TEXT, fetchImpl: f }), {
    ok: false,
    reason: 'cookie 不完整',
  })

  const okRoot = mkRoot({ cookie: COOKIE })
  assert.equal(
    (await postComment({ root: okRoot, bvid: BVID, text: '   ', fetchImpl: f })).reason,
    '没话可说',
  )
  assert.equal(
    (await postComment({ root: okRoot, bvid: BVID, text: '字'.repeat(301), fetchImpl: f })).reason,
    '太长了',
  )
  assert.equal(f.calls.length, 0)
})

test('bili：先查 aid 再发评论，表单四字段对，日志里没有 cookie', async () => {
  const root = mkRoot({ cookie: COOKIE })
  const logLines = []
  let replyCall = null
  const f = fakeFetch((url, opts) => {
    if (url.startsWith(VIEW_API)) return replyJson({ code: 0, data: { aid: 123456 } })
    if (url === REPLY_API) {
      replyCall = { url, opts }
      return replyJson({ code: 0, data: { rpid: 1 } })
    }
    throw new Error(`没想到的请求：${url}`)
  })

  const r = await postComment({
    root,
    bvid: BVID,
    text: TEXT,
    fetchImpl: f,
    log: (line) => logLines.push(String(line)),
  })
  assert.deepEqual(r, { ok: true })
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls[0].url.startsWith(VIEW_API))
  assert.equal(f.calls[1].url, REPLY_API)

  assert.ok(replyCall, '没有发出评论请求')
  const form = new URLSearchParams(replyCall.opts.body)
  assert.equal(form.get('oid'), '123456')
  assert.equal(form.get('type'), '1')
  assert.equal(form.get('message'), TEXT)
  assert.equal(form.get('csrf'), 'csrf-token-123')
  assert.equal(replyCall.opts.method, 'POST')
  assert.equal(replyCall.opts.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(replyCall.opts.headers.cookie, COOKIE)

  // 假 log 一条都不许带 cookie 原文
  for (const line of logLines) {
    assert.ok(!line.includes('SESSDATA'), '日志里出现了 SESSDATA')
    assert.ok(!line.includes('csrf-token-123'), '日志里出现了 bili_jct')
  }

  // 失败时也会 log 一句；那句同样不许带 cookie
  const failLog = []
  const failFetch = fakeFetch((url) =>
    url.startsWith(VIEW_API)
      ? replyJson({ code: 0, data: { aid: 123456 } })
      : replyJson({ code: -101, message: '账号未登录' }),
  )
  const bad = await postComment({
    root,
    bvid: BVID,
    text: TEXT,
    fetchImpl: failFetch,
    log: (line) => failLog.push(String(line)),
  })
  assert.deepEqual(bad, { ok: false, reason: '没登录' })
  assert.ok(failLog.length > 0, '失败时应当 log 一句')
  for (const line of failLog) {
    assert.ok(!line.includes('SESSDATA'), '失败日志里出现了 SESSDATA')
    assert.ok(!line.includes('csrf-token-123'), '失败日志里出现了 bili_jct')
  }
})

test('bili：B 站错误码翻成人话（-101 / -412 / 12051）', async () => {
  const cases = [
    [-101, '没登录'],
    [-412, '被风控了'],
    [12051, '评论太频繁'],
  ]
  for (const [code, reason] of cases) {
    const root = mkRoot({ cookie: COOKIE })
    const f = fakeFetch((url) =>
      url.startsWith(VIEW_API)
        ? replyJson({ code: 0, data: { aid: 42 } })
        : replyJson({ code, message: 'x' }),
    )
    const r = await postComment({ root, bvid: BVID, text: TEXT, fetchImpl: f })
    assert.deepEqual(r, { ok: false, reason })
  }
})

test('bili：连不上 / 解析失败都不抛，折成 {ok:false, reason}', async () => {
  const root = mkRoot({ cookie: COOKIE })
  const boom = async () => {
    throw new Error('offline')
  }
  const r1 = await postComment({ root, bvid: BVID, text: TEXT, fetchImpl: boom })
  assert.equal(r1.ok, false)
  assert.ok(typeof r1.reason === 'string' && r1.reason.length > 0)

  const garbage = fakeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('bad json')
    },
  }))
  assert.equal((await bvidToAid(BVID, { fetchImpl: garbage })).ok, false)
  assert.equal((await hot({ fetchImpl: boom })).ok, false)
  const r3 = await postComment({ root, bvid: BVID, text: TEXT, fetchImpl: garbage })
  assert.equal(r3.ok, false)
  assert.ok(typeof r3.reason === 'string' && r3.reason.length > 0)
})
