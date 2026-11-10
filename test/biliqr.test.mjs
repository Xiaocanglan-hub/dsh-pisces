// biliqr.js：B 站扫码登录（移植自 dsh-fish）。
// 全部注入假 fetch / 假时钟，测试绝不连网；owner.json 写在临时目录里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createQrLogin, QR_TTL_MS } from '../lib/biliqr.js'
import { NAV_API, OWNER_FILE, readBili } from '../lib/bili.js'

const GEN_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'

const COOKIE_LINES = [
  'SESSDATA=sess-secret-value; Path=/; Domain=.bilibili.com; HttpOnly',
  'bili_jct=csrf-token-123; Path=/',
  'DedeUserID=42; Path=/',
]

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-biliqr-'))
}

/** 假响应：text()/json() 给 JSON，headers.getSetCookie() 给 Set-Cookie 行。 */
function res(body, { cookies = [] } = {}) {
  return {
    status: 200,
    ok: true,
    headers: { getSetCookie: () => cookies },
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    },
  }
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

const genOk = () => res({ code: 0, data: { url: 'https://passport.bilibili.com/login?key=k1', qrcode_key: 'k1' } })
const navOk = () => res({ code: 0, data: { isLogin: true, uname: '小鱼', mid: 42 } })

test('biliqr：start 拿到 key 和当场画的 SVG；1.2 秒内不许连开两张', async () => {
  let t = 0
  let genCalls = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) {
      genCalls += 1
      return genOk()
    }
    throw new Error(`没想到的请求：${url}`)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })

  const a = await qr.start()
  assert.equal(a.ok, true)
  assert.equal(a.key, 'k1')
  assert.equal(a.ttlMs, QR_TTL_MS)
  assert.ok(a.svg.startsWith('<svg '), '要当场画 SVG，不借第三方图片服务')
  assert.equal(qr.size(), 1)

  t = 500
  const b = await qr.start()
  assert.equal(b.ok, false)
  assert.ok(b.retryAfterMs > 0)
  assert.equal(genCalls, 1, '节流时不该再打 B 站')

  t = 2_000
  assert.equal((await qr.start()).ok, true)
})

test('biliqr：start 失败折成人话（连不上 / B 站没给码）', async () => {
  const boom = createQrLogin({
    now: () => 0,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  const r1 = await boom.start()
  assert.equal(r1.ok, false)
  assert.match(r1.why, /连不上 B 站/)

  const noCode = createQrLogin({
    now: () => 0,
    fetchImpl: fakeFetch(() => res({ code: -412, message: '风控' })),
  })
  const r2 = await noCode.start()
  assert.equal(r2.ok, false)
  assert.match(r2.why, /-412/)

  const noUrl = createQrLogin({
    now: () => 0,
    fetchImpl: fakeFetch(() => res({ code: 0, data: { qrcode_key: 'k1' } })),
  })
  assert.equal((await noUrl.start()).ok, false)
})

test('biliqr：轮询 86101 → 86090 → 确认，认出登的是谁；cookie 不进返回值', async () => {
  let t = 0
  let pollNo = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) return genOk()
    if (url.startsWith(POLL_URL)) {
      pollNo += 1
      if (pollNo === 1) return res({ code: 0, data: { code: 86101 } })
      if (pollNo === 2) return res({ code: 0, data: { code: 86090 } })
      return res({ code: 0, data: { code: 0 } }, { cookies: COOKIE_LINES })
    }
    if (url === NAV_API) return navOk()
    throw new Error(`没想到的请求：${url}`)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })
  const { key } = await qr.start()

  t = 1_000
  assert.equal((await qr.poll(key)).state, 'waiting')

  t = 2_000
  const scanned = await qr.poll(key)
  assert.equal(scanned.state, 'scanned')
  assert.match(scanned.why, /确认登录/)

  t = 3_000
  const done = await qr.poll(key)
  assert.equal(done.state, 'confirmed')
  assert.deepEqual(done.account, { mid: '42', name: '小鱼' })
  assert.equal(JSON.stringify(done).includes('SESSDATA'), false, 'cookie 不许回给页面')

  // 再问一次不会再打 B 站，直接回 confirmed
  const before = f.calls.length
  t = 4_000
  const again = await qr.poll(key)
  assert.equal(again.state, 'confirmed')
  assert.equal(f.calls.length, before)
})

test('biliqr：没有 SESSDATA / 没有 bili_jct 都算这次登录失败（不存半张票）', async () => {
  let t = 0
  const run = (cookies) => {
    t = 0
    const f = fakeFetch((url) => {
      if (url.startsWith(GEN_URL)) return genOk()
      if (url.startsWith(POLL_URL)) return res({ code: 0, data: { code: 0 } }, { cookies })
      if (url === NAV_API) return navOk()
      throw new Error(url)
    })
    const qr = createQrLogin({ now: () => t, fetchImpl: f })
    return qr.start().then((r) => {
      t = 2_000
      return { qr, key: r.key }
    })
  }

  const noSess = await run(['bili_jct=csrf; Path=/'])
  assert.equal((await noSess.qr.poll(noSess.key)).state, 'error')

  const noJct = await run(['SESSDATA=sess; Path=/'])
  const r = await noJct.qr.poll(noJct.key)
  assert.equal(r.state, 'error')
  assert.match(r.why, /bili_jct/)
})

test('biliqr：save 必须等确认；确认后写 owner.json（名字/uid 一起），页面只拿到名字', async () => {
  let t = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) return genOk()
    if (url.startsWith(POLL_URL)) return res({ code: 0, data: { code: 0 } }, { cookies: COOKIE_LINES })
    if (url === NAV_API) return navOk()
    throw new Error(url)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })
  const root = mkRoot()
  const { key } = await qr.start()

  const early = await qr.save(key, root)
  assert.equal(early.ok, false)
  assert.match(early.why, /还没扫码确认/)
  assert.equal(existsSync(path.join(root, OWNER_FILE)), false)

  t = 2_000
  await qr.poll(key)
  const saved = await qr.save(key, root)
  assert.equal(saved.ok, true)
  assert.equal(saved.name, '小鱼')

  const owner = readBili(root)
  assert.equal(owner.name, '小鱼')
  assert.equal(owner.mid, 42)
  assert.match(owner.cookie, /SESSDATA=sess-secret-value/)
  assert.match(owner.cookie, /bili_jct=csrf-token-123/)
  assert.equal(qr.peek(key), null, '存完这张码就该忘掉')
})

test('biliqr：过期之后既不轮询也不接受 save', async () => {
  let t = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) return genOk()
    throw new Error(`过期后不该再请求：${url}`)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })
  const root = mkRoot()
  const { key } = await qr.start()

  t = QR_TTL_MS + 1
  const r = await qr.poll(key)
  assert.equal(r.state, 'expired')
  const s = await qr.save(key, root)
  assert.equal(s.ok, false)
  assert.match(s.why, /过期/)
})

test('biliqr：800ms 内第二次轮询回上次的结果（throttled），不打扰 B 站', async () => {
  let t = 0
  let polls = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) return genOk()
    if (url.startsWith(POLL_URL)) {
      polls += 1
      return res({ code: 0, data: { code: 86101 } })
    }
    throw new Error(url)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })
  const { key } = await qr.start()

  t = 1_000
  await qr.poll(key)
  t = 1_200
  const throttled = await qr.poll(key)
  assert.equal(throttled.throttled, true)
  assert.equal(polls, 1)
})

test('biliqr：drop / clear 把内存里攥着的 cookie 一起忘掉', async () => {
  let t = 0
  const f = fakeFetch((url) => {
    if (url.startsWith(GEN_URL)) return genOk()
    if (url.startsWith(POLL_URL)) return res({ code: 0, data: { code: 0 } }, { cookies: COOKIE_LINES })
    if (url === NAV_API) return navOk()
    throw new Error(url)
  })
  const qr = createQrLogin({ now: () => t, fetchImpl: f })
  const a = await qr.start()
  t = 2_000
  await qr.poll(a.key)
  assert.equal(qr.peek(a.key).hasCookie, true)

  qr.drop(a.key)
  assert.equal(qr.peek(a.key), null)

  const b = await qr.start()
  t = 4_000
  await qr.poll(b.key)
  qr.clear()
  assert.equal(qr.size(), 0)
  assert.equal(qr.peek(b.key), null)
})
