// 百度贴吧登录（lib/baidu.js）：只收 BDUSS/STOKEN，保存时验一次。
// 全部注入假 fetch，测试绝不连网；baidu.json 写在临时目录里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BAIDU_FILE,
  TBS_API,
  USERINFO_API,
  checkBaidu,
  loginBaidu,
  parseBaiduCookie,
  readBaidu,
  writeBaidu,
} from '../lib/baidu.js'

const COOKIE = 'BDUSS=bduss-secret-value; STOKEN=stoken-secret-value'
const TEXT = 'BDUSS=bduss-secret-value; STOKEN=stoken-secret-value; PSTM=123; BAIDUID=abc'

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-baidu-'))
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

const jsonRes = (body) => ({ ok: true, status: 200, async json() { return body } })

test('baidu：parse 只留 BDUSS/STOKEN，其它键丢掉并拼回规范形状', () => {
  const r = parseBaiduCookie(TEXT)
  assert.equal(r.ok, true)
  assert.equal(r.cookie, COOKIE)
  assert.deepEqual(r.missing, [])
  assert.ok(!r.cookie.includes('PSTM'), '别的键不该留下')

  // 换行分隔也认
  const multi = parseBaiduCookie('BDUSS=abc\nSTOKEN=def')
  assert.deepEqual(multi, { ok: true, cookie: 'BDUSS=abc; STOKEN=def', missing: [] })
})

test('baidu：缺 STOKEN 回 cookie 不完整，并说清缺哪个', () => {
  const r = parseBaiduCookie('BDUSS=abc')
  assert.equal(r.ok, false)
  assert.match(r.reason, /cookie 不完整/)
  assert.match(r.reason, /STOKEN/)
  assert.equal(r.cookie, undefined)
})

test('baidu：乱文本（没有键值对）也回 cookie 不完整，不抛', () => {
  for (const bad of ['', '   ', '随便一段文本', 'http://tieba.baidu.com', 'BDUSS=; STOKEN=']) {
    const r = parseBaiduCookie(bad)
    assert.equal(r.ok, false)
    assert.match(r.reason, /cookie 不完整/)
  }
})

test('baidu：writeBaidu 落盘 0600，readBaidu 读回；坏文件/缺键回 null', () => {
  const root = mkRoot()
  const rec = writeBaidu(root, { cookie: TEXT, name: '贴吧小明' })
  assert.equal(rec.cookie, COOKIE)

  const file = path.join(root, BAIDU_FILE)
  assert.equal(existsSync(file), true)
  const saved = readBaidu(root)
  assert.equal(saved.cookie, COOKIE)
  assert.equal(saved.name, '贴吧小明')
  assert.equal(typeof saved.at, 'number')

  const mode = statSync(file).mode & 0o777
  if (process.platform === 'win32') {
    // Windows 不保留 POSIX 位：Node 一律报 0666。至少证明文件不是只读。
    assert.equal(mode & 0o200, 0o200, `Windows 上文件应该可写，实际 ${mode.toString(8)}`)
  } else {
    assert.equal(mode, 0o600)
  }

  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  assert.equal(readBaidu(root), null)

  writeFileSync(file, JSON.stringify({ cookie: 'BDUSS=abc', at: Date.now() }), 'utf8')
  assert.equal(readBaidu(root), null, '缺 STOKEN 的文件不能当登录态')
})

test('baidu：checkBaidu 成功——is_login=1，带规范 cookie/浏览器 UA，取 user_name', async () => {
  const f = fakeFetch((url, opts) => {
    if (url === TBS_API) {
      assert.equal(opts.headers.cookie, COOKIE)
      assert.match(opts.headers['user-agent'], /Mozilla/)
      return jsonRes({ is_login: 1 })
    }
    if (url === USERINFO_API) {
      assert.equal(opts.headers.cookie, COOKIE)
      return jsonRes({ no: 0, data: { user_name: '贴吧小明' } })
    }
    throw new Error(`没想到的请求：${url}`)
  })

  const r = await checkBaidu({ cookie: TEXT, fetchImpl: f })
  assert.deepEqual(r, { ok: true, name: '贴吧小明' })
  assert.equal(f.calls.length, 2)

  // 名字拿不到不算失败，回空串
  const noName = fakeFetch((url) =>
    url === TBS_API ? jsonRes({ is_login: 1 }) : jsonRes({ no: 1, error: 'nope' }),
  )
  assert.deepEqual(await checkBaidu({ cookie: COOKIE, fetchImpl: noName }), { ok: true, name: '' })
})

test('baidu：未登录 / 网络错 / 不完整 都折成人话 reason，不抛', async () => {
  const notLogin = fakeFetch(() => jsonRes({ is_login: 0 }))
  assert.deepEqual(await checkBaidu({ cookie: COOKIE, fetchImpl: notLogin }), {
    ok: false,
    reason: '没登录',
  })

  const offline = fakeFetch(() => {
    throw new Error('offline')
  })
  assert.deepEqual(await checkBaidu({ cookie: COOKIE, fetchImpl: offline }), {
    ok: false,
    reason: '连不上贴吧',
  })

  const garbage = fakeFetch(() => ({ ok: true, status: 200, async json() { throw new Error('bad') } }))
  assert.deepEqual(await checkBaidu({ cookie: COOKIE, fetchImpl: garbage }), {
    ok: false,
    reason: '连不上贴吧',
  })

  const probe = fakeFetch(() => {
    throw new Error('cookie 不完整时不该发请求')
  })
  assert.deepEqual(await checkBaidu({ cookie: 'BDUSS=abc', fetchImpl: probe }), {
    ok: false,
    reason: 'cookie 不完整',
  })
  assert.equal(probe.calls.length, 0)
})

test('baidu：loginBaidu 成功才写文件；验证失败 / 缺键一个字节都不写', async () => {
  const good = fakeFetch((url) =>
    url === TBS_API ? jsonRes({ is_login: 1 }) : jsonRes({ data: { user_name: '贴吧小明' } }),
  )
  const root = mkRoot()
  assert.deepEqual(await loginBaidu({ root, text: TEXT, fetchImpl: good }), {
    ok: true,
    name: '贴吧小明',
  })
  assert.equal(readBaidu(root).name, '贴吧小明')

  const badRoot = mkRoot()
  const notLogin = fakeFetch(() => jsonRes({ is_login: 0 }))
  assert.deepEqual(await loginBaidu({ root: badRoot, text: TEXT, fetchImpl: notLogin }), {
    ok: false,
    reason: '没登录',
  })
  assert.equal(existsSync(path.join(badRoot, BAIDU_FILE)), false)

  const incompleteRoot = mkRoot()
  const probe = fakeFetch(() => {
    throw new Error('缺键时不该发请求')
  })
  const bad = await loginBaidu({ root: incompleteRoot, text: 'BDUSS=abc', fetchImpl: probe })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /STOKEN/)
  assert.equal(probe.calls.length, 0)
  assert.equal(existsSync(path.join(incompleteRoot, BAIDU_FILE)), false)
})
