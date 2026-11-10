// B 站（lib/bili.js）：登录（cookie）+ 只读热门 + 在视频下说一句。
// 全部注入假 fetch，测试绝不连网；owner.json 写在临时目录里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  NAV_API,
  OWNER_FILE,
  POPULAR_API,
  REPLY_API,
  VIEW_API,
  bvidToAid,
  checkBili,
  clearBili,
  hot,
  loginBili,
  parseBiliCookie,
  postComment,
  readBili,
  readOwner,
  writeBili,
} from '../lib/bili.js'

const BVID = 'BV1xx411c7mD'
const COOKIE = 'SESSDATA=sess-secret-value; bili_jct=csrf-token-123'
const RAW = `${COOKIE}; DedeUserID=42; b_nut=1700000000`
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

// ---------------------------------------------------------------- 登录（cookie）

test('bili 登录：parse 只留 SESSDATA/bili_jct，其它键丢掉并拼回规范形状', () => {
  const r = parseBiliCookie(RAW)
  assert.equal(r.ok, true)
  assert.equal(r.cookie, COOKIE)
  assert.deepEqual(r.missing, [])
  assert.ok(!r.cookie.includes('DedeUserID'), '别的键不该留下')

  // 换行分隔也认
  const multi = parseBiliCookie('SESSDATA=abc\nbili_jct=def')
  assert.deepEqual(multi, { ok: true, cookie: 'SESSDATA=abc; bili_jct=def', missing: [] })
})

test('bili 登录：缺 bili_jct 说清缺哪个；乱文本也回 cookie 不完整', () => {
  const r = parseBiliCookie('SESSDATA=abc')
  assert.equal(r.ok, false)
  assert.match(r.reason, /cookie 不完整/)
  assert.match(r.reason, /bili_jct/)
  assert.equal(r.cookie, undefined)

  for (const bad of ['', '   ', '随便一段文本', 'https://www.bilibili.com', 'SESSDATA=; bili_jct=']) {
    const out = parseBiliCookie(bad)
    assert.equal(out.ok, false)
    assert.match(out.reason, /cookie 不完整/)
  }
})

test('bili 登录：writeBili 落盘 0600，readBili 读回；坏文件/缺键回 null；clearBili 删掉', () => {
  const root = mkRoot()
  const rec = writeBili(root, { cookie: RAW, name: '小苍兰', mid: 25237 })
  assert.equal(rec.cookie, COOKIE)

  const file = path.join(root, OWNER_FILE)
  assert.equal(existsSync(file), true)
  const saved = readBili(root)
  assert.equal(saved.cookie, COOKIE)
  assert.equal(saved.name, '小苍兰')
  assert.equal(saved.mid, 25237)
  assert.equal(typeof saved.at, 'number')

  const mode = statSync(file).mode & 0o777
  if (process.platform === 'win32') {
    // Windows 不保留 POSIX 位：读回可能是 0600 或 0666，别把测试写成平台绑死。
    assert.ok(mode === 0o600 || mode === 0o666, `Windows mode=${mode.toString(8)}`)
  } else {
    assert.equal(mode, 0o600)
  }

  // 坏文件 / 缺键 / 不是对象 一律 null
  assert.equal(readBili(mkRoot('{ 这不是 JSON')), null)
  assert.equal(readBili(mkRoot({ cookie: 'SESSDATA=abc' })), null)
  assert.equal(readBili(mkRoot({ cookie: 42 })), null)
  assert.equal(readBili(null), null)

  // 老形状（只有 cookie）也能读，名字缺省不给
  const legacy = readBili(mkRoot({ cookie: RAW }))
  assert.equal(legacy.cookie, COOKIE)
  assert.equal(legacy.name, undefined)

  assert.equal(clearBili(root), true)
  assert.equal(readBili(root), null)
  assert.equal(clearBili(root), false, '再删一次返回 false，不抛')
})

test('bili 登录：再存一次会把上一份留成 owner.json.bak（点错还能翻回来）', () => {
  const root = mkRoot()
  writeBili(root, { cookie: COOKIE, name: '旧的', mid: 1 })
  writeBili(root, { cookie: 'SESSDATA=new-sess; bili_jct=new-jct', name: '新的', mid: 2 })

  assert.equal(readBili(root).name, '新的')
  const bakFile = path.join(root, `${OWNER_FILE}.bak`)
  assert.equal(existsSync(bakFile), true, '覆盖前要留一份 .bak')
  const bak = JSON.parse(readFileSync(bakFile, 'utf8'))
  assert.equal(bak.cookie, COOKIE)
  assert.equal(bak.name, '旧的')
})

test('bili 登录：checkBili 成功——isLogin 才算，取 uname/mid，带规范 cookie 与浏览器 UA', async () => {
  const f = fakeFetch((url, opts) => {
    assert.equal(url, NAV_API)
    assert.equal(opts.headers.cookie, COOKIE)
    assert.match(opts.headers['user-agent'], /Mozilla\/5\.0/)
    return replyJson({
      code: 0,
      data: { isLogin: true, uname: '小苍兰', mid: 25237, money: 0 },
    })
  })
  assert.deepEqual(await checkBili({ cookie: RAW, fetchImpl: f }), {
    ok: true,
    name: '小苍兰',
    mid: 25237,
  })
  assert.equal(f.calls.length, 1)

  // cookie 不完整：一个请求都不发
  const probe = fakeFetch(() => {
    throw new Error('不完整时不该发请求')
  })
  assert.deepEqual(await checkBili({ cookie: 'SESSDATA=abc', fetchImpl: probe }), {
    ok: false,
    reason: 'cookie 不完整',
  })
  assert.equal(probe.calls.length, 0)
})

test('bili 登录：未登录 / 风控 / 连不上 都折成人话，不抛', async () => {
  // 接口回 -101
  assert.deepEqual(
    await checkBili({ cookie: RAW, fetchImpl: fakeFetch(() => replyJson({ code: -101, message: '账号未登录' })) }),
    { ok: false, reason: '没登录' },
  )
  // code 0 但 isLogin:false（没有有效 SESSDATA 的常见形状）
  assert.deepEqual(
    await checkBili({ cookie: RAW, fetchImpl: fakeFetch(() => replyJson({ code: 0, data: { isLogin: false } })) }),
    { ok: false, reason: '没登录' },
  )
  // 风控
  assert.deepEqual(
    await checkBili({ cookie: RAW, fetchImpl: fakeFetch(() => replyJson({ code: -412 })) }),
    { ok: false, reason: '被风控了' },
  )
  // 网络错 / 回包坏
  const boom = async () => {
    throw new Error('offline')
  }
  assert.deepEqual(await checkBili({ cookie: RAW, fetchImpl: boom }), { ok: false, reason: '连不上 B 站' })
  const garbage = fakeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('bad json')
    },
  }))
  assert.deepEqual(await checkBili({ cookie: RAW, fetchImpl: garbage }), {
    ok: false,
    reason: '连不上 B 站',
  })
})

test('bili 登录：loginBili 成功才写文件；验证失败 / 缺键一个字节都不写', async () => {
  const root = mkRoot()
  const okFetch = fakeFetch(() => replyJson({ code: 0, data: { isLogin: true, uname: '小苍兰', mid: 7 } }))
  const ok = await loginBili({ root, text: RAW, fetchImpl: okFetch })
  assert.deepEqual(ok, { ok: true, name: '小苍兰' })
  assert.equal(readBili(root).name, '小苍兰')
  assert.equal(readBili(root).mid, 7)

  // 验证失败：不写
  const badRoot = mkRoot()
  const bad = await loginBili({
    root: badRoot,
    text: COOKIE,
    fetchImpl: fakeFetch(() => replyJson({ code: 0, data: { isLogin: false } })),
  })
  assert.deepEqual(bad, { ok: false, reason: '没登录' })
  assert.equal(existsSync(path.join(badRoot, OWNER_FILE)), false)

  // 缺键：连验证都不发
  const noJct = mkRoot()
  const probe = fakeFetch(() => {
    throw new Error('缺键不该发请求')
  })
  const r = await loginBili({ root: noJct, text: 'SESSDATA=abc', fetchImpl: probe })
  assert.equal(r.ok, false)
  assert.equal(probe.calls.length, 0)
  assert.equal(existsSync(path.join(noJct, OWNER_FILE)), false)

  // 没有地方存
  assert.deepEqual(await loginBili({ root: '', text: RAW, fetchImpl: okFetch }), {
    ok: false,
    reason: '没有地方存',
  })
})

test('bili 登录：登录后的 owner.json 能直接给 speak 用（readOwner 读到 csrf）', async () => {
  const root = mkRoot()
  await loginBili({
    root,
    text: RAW,
    fetchImpl: fakeFetch(() => replyJson({ code: 0, data: { isLogin: true, uname: 'x', mid: 1 } })),
  })
  const owner = readOwner(root)
  assert.equal(owner.cookie, COOKIE)
  assert.equal(owner.csrf, 'csrf-token-123')
})
