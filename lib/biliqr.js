// biliqr.js —— B 站扫码登录（宿主侧）。
//
// 移植说明（2026-11-10）：取自 dsh-fish 的 `lib/biliqr.js`（MIT，Copyright (c) 2026
// 大肥鱼（dsh-fish）作者；扫码登录由 @Bacon-01 贡献，PR #17）。按本插件改了三处：
// 1. 落盘走 `lib/bili.js` 的 writeBili（owner.json，0600 原子写），不再单独存 account；
// 2. 认账号走 `checkBili`（nav 接口），不依赖 dsh-fish 的 createClient；
// 3. 没有 bili_jct 的登录不给存——这个插件的 B 站登录只为了说话，发评论必须有 csrf。
//
// 为什么不在浏览器里直接请求 B 站：
//   generate / poll 这两个接口没有 CORS 头，页面里 fetch 一律被浏览器挡死。
//   所以二维码的生成、轮询、换 cookie 全在宿主这一侧做，页面只跟 `/dsh-pisces-api/bili/qr*` 说话。
//
// 三条安全约定（比功能本身重要）：
//   1. **key 与 cookie 只活在内存里**。没点「保存」之前不落盘、不进日志、不回给页面。
//      页面拿到的只有「登的是谁」（昵称 + uid），永远拿不到 cookie 原文 —— 和粘贴那条路同一条规矩。
//   2. **确认才写盘**。轮询到 DONE 只是把 cookie 攥在 pending 里，写 owner.json 要人再点一次。
//   3. **过期就不认**。180 秒之后既不再轮询，也不接受 save；丢掉就是丢掉，下次重新生成。
//
// 状态机：waiting → scanned → confirmed → （人点保存）saved
//              ↘ expired / error / gone
import { checkBili, writeBili } from './bili.js'
import { qrSvg } from './qr.js'

const GEN_URL =
  'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) =>
  `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?source=main-fe-header&qrcode_key=${encodeURIComponent(key)}`

// B 站对这个接口比较挑 UA：拿 node 默认 UA 去问，偶尔会直接给 -412。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const QR_TTL_MS = 180_000
const FORGET_MS = QR_TTL_MS + 120_000 // 过期之后再留一会儿：让人还能看到"已过期"而不是"不存在"
const MAX_PENDING = 3
const MIN_POLL_GAP_MS = 800
const MIN_START_GAP_MS = 1_200

// 只留这几个键（和 dsh-fish 的 owner.js 对齐；buvid3 有时给、有时不给，有就留着）。
const WANT = ['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']

/** 把 Set-Cookie 那几行里我们要的键抠出来。 */
function pickCookies(headers) {
  let lines = []
  try {
    if (typeof headers?.getSetCookie === 'function') lines = headers.getSetCookie() ?? []
  } catch {
    lines = []
  }
  if (!lines.length) {
    const raw = headers?.get?.('set-cookie') ?? ''
    // 兜底：没有 getSetCookie 的老运行时。expires 里也有逗号，所以只在"逗号后面跟着 name="处切。
    if (raw) lines = String(raw).split(/,(?=\s*[A-Za-z0-9_]+=)/)
  }
  const got = {}
  for (const line of lines) {
    const head = String(line).split(';')[0]
    const i = head.indexOf('=')
    if (i <= 0) continue
    const name = head.slice(0, i).trim()
    const value = head.slice(i + 1).trim()
    if (WANT.includes(name) && value) got[name] = value
  }
  return got
}

/** 拼成 owner.json 里那种 `a=1; b=2` 的形状（顺序固定，测试好比对）。 */
function joinCookies(got) {
  return WANT.filter((n) => got[n])
    .map((n) => `${n}=${got[n]}`)
    .join('; ')
}

/**
 * 建一个扫码登录的小机器。fetch / 时钟 / 日志都做成可注入，单测不用打真网。
 * @param {{fetchImpl?:Function, now?:()=>number, log?:(m:string)=>void}} [opts]
 */
export function createQrLogin(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})

  /** @type {Map<string, {key:string,url:string,createdAt:number,lastPollAt:number,state:string,cookie:string,account:{mid:string,name:string}|null,note:string}>} */
  const pending = new Map()
  // -Infinity 起步：注入的时钟可能从 0 开始，别让"上一次生成"的初值把第一张码节流掉。
  let lastStart = -Infinity

  function sweep() {
    const t = now()
    for (const [k, e] of pending) {
      if (t - e.createdAt > FORGET_MS) pending.delete(k)
    }
    // 超出上限就先丢最老的：这是本机上的登录窗口，不是缓存，不心疼。
    while (pending.size > MAX_PENDING) {
      const oldest = [...pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
      if (!oldest) break
      pending.delete(oldest[0])
    }
  }

  async function request(url) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 12_000)
    try {
      return await fetchImpl(url, {
        signal: ctl.signal,
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 生成一张新码。返回里的 svg 直接给页面当图用：
   * 登录 URL 里有 qrcode_key，走第三方图片服务等于把钥匙递出去。
   */
  async function start() {
    sweep()
    const t = now()
    if (t - lastStart < MIN_START_GAP_MS) {
      return {
        ok: false,
        why: '刚生成过，等一秒再点。',
        retryAfterMs: MIN_START_GAP_MS - (t - lastStart),
      }
    }
    lastStart = t

    let res
    try {
      res = await request(GEN_URL)
    } catch (err) {
      return { ok: false, why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}` }
    }
    let body
    try {
      body = JSON.parse(await res.text())
    } catch {
      return { ok: false, why: `B 站回的不是 JSON（HTTP ${res.status}）` }
    }
    const url = String(body?.data?.url ?? '')
    const key = String(body?.data?.qrcode_key ?? '')
    if (body?.code !== 0 || !url || !key) {
      return { ok: false, why: `B 站没给码：${body?.code ?? '?'} ${body?.message ?? ''}`.trim() }
    }

    let svg = ''
    try {
      svg = qrSvg(url, { ec: 'M', scale: 6, margin: 3 })
    } catch (err) {
      // 画不出来多半是 URL 长得超出预期：宁可当场说清楚，也别给一张扫不出的图。
      return { ok: false, why: `二维码画不出来：${String(err?.message ?? err).slice(0, 60)}` }
    }

    pending.set(key, {
      key,
      url,
      createdAt: t,
      lastPollAt: 0,
      state: 'waiting',
      cookie: '',
      account: null,
      note: '',
    })
    // 放进去之后再收一次：MAX_PENDING 管的是"此刻攥着几把钥匙"，不是"放之前有几把"。
    sweep()
    return { ok: true, key, svg, ttlMs: QR_TTL_MS, expiresAt: t + QR_TTL_MS }
  }

  /** 轮询一次。页面每秒问一次也没关系：真请求有 800ms 的下限。 */
  async function poll(key) {
    sweep()
    const e = pending.get(String(key ?? ''))
    if (!e) return { state: 'gone', why: '这张码已经不在了，重新点「扫码登录」。' }

    if (e.state === 'confirmed') {
      return { state: 'confirmed', account: e.account, note: e.note }
    }
    if (e.state === 'saved') return { state: 'saved', account: e.account }
    if (e.state === 'expired') return { state: 'expired', why: '二维码过期了，点「换一张」重来。' }
    if (e.state === 'error') return { state: 'error', why: e.note }

    const t = now()
    if (t - e.createdAt > QR_TTL_MS) {
      e.state = 'expired'
      return { state: 'expired', why: '二维码过期了，点「换一张」重来。' }
    }
    // 太密就回上次的结果，不打扰 B 站
    if (t - e.lastPollAt < MIN_POLL_GAP_MS) {
      return { state: e.state, throttled: true, expiresAt: e.createdAt + QR_TTL_MS }
    }
    e.lastPollAt = t

    let res
    try {
      res = await request(pollUrl(e.key))
    } catch (err) {
      return {
        state: e.state,
        why: `连不上 B 站：${String(err?.message ?? err).slice(0, 60)}`,
        expiresAt: e.createdAt + QR_TTL_MS,
      }
    }

    let body
    const text = await res.text().catch(() => '')
    try {
      body = JSON.parse(text)
    } catch {
      return {
        state: e.state,
        why: `B 站回的不是 JSON（HTTP ${res.status}）`,
        expiresAt: e.createdAt + QR_TTL_MS,
      }
    }
    // 顶层 code 不对（-412 风控之类）：这次不算数，接着轮询
    if (body?.code !== 0) {
      return {
        state: e.state,
        why: `B 站：${body?.code} ${body?.message ?? ''}`.trim(),
        expiresAt: e.createdAt + QR_TTL_MS,
      }
    }

    const code = Number(body?.data?.code ?? body?.code)
    if (code === 86101) {
      e.state = 'waiting'
      return { state: 'waiting', expiresAt: e.createdAt + QR_TTL_MS }
    }
    if (code === 86090) {
      e.state = 'scanned'
      return {
        state: 'scanned',
        why: '扫到了，在手机上点一下「确认登录」。',
        expiresAt: e.createdAt + QR_TTL_MS,
      }
    }
    if (code === 86038) {
      e.state = 'expired'
      return { state: 'expired', why: '二维码过期了，点「换一张」重来。' }
    }
    if (code !== 0) {
      return {
        state: e.state,
        why: `B 站：${code} ${body?.data?.message ?? ''}`.trim(),
        expiresAt: e.createdAt + QR_TTL_MS,
      }
    }

    // ---- 到这里就是登录成功了 ----
    const cookie = joinCookies(pickCookies(res.headers))
    if (!/SESSDATA=/.test(cookie)) {
      e.state = 'error'
      e.note = '扫码成功了，但 B 站没把 SESSDATA 发下来'
      log('扫码成功但没有 SESSDATA，放弃这次登录')
      return { state: 'error', why: e.note }
    }
    if (!/bili_jct=/.test(cookie)) {
      // 这个插件的 B 站登录只为了说话；没有 csrf 的登录存了也没用，当场说清楚。
      e.state = 'error'
      e.note = '这份登录里没有 bili_jct（发不了评论），换一个号重扫吧。'
      return { state: 'error', why: e.note }
    }
    e.cookie = cookie
    e.state = 'confirmed'

    // 认一下这是谁。认不出来（网络抖动）不算失败：cookie 已经拿到了。
    let account = null
    try {
      const me = await checkBili({ cookie, fetchImpl })
      if (me?.ok) account = { mid: String(me.mid ?? ''), name: String(me.name ?? '') }
      else if (!e.note) e.note = 'cookie 拿到了，但暂时认不出是哪个账号。'
    } catch (err) {
      if (!e.note) e.note = `cookie 拿到了，但认账号时连不上 B 站：${String(err?.message ?? err).slice(0, 40)}`
    }
    e.account = account
    log(`扫码登录确认：${account?.name ? `${account.name}(uid ${account.mid})` : '未知账号'}`)
    return { state: 'confirmed', account, note: e.note }
  }

  /**
   * 人点了「保存」才写盘。
   * 写的是 owner.json 的 cookie + 只读的名字/uid；别的东西一个字都不碰。
   */
  async function save(key, root) {
    sweep()
    const e = pending.get(String(key ?? ''))
    if (!e) return { ok: false, why: '这张码已经不在了，重新扫码。' }
    // 过期先判：过期之后不管扫没扫到都只能说"过期"，说"还没确认"会让人干等。
    if (now() - e.createdAt > QR_TTL_MS) {
      e.state = 'expired'
      pending.delete(e.key)
      return { ok: false, why: '这张码过期了，重新扫码再存。' }
    }
    if (e.state !== 'confirmed') return { ok: false, why: '还没扫码确认，先别存。' }
    const id = Number(e.account?.mid)
    try {
      writeBili(root, {
        cookie: e.cookie,
        name: e.account?.name ?? '',
        mid: Number.isFinite(id) && id > 0 ? id : undefined,
      })
    } catch {
      return { ok: false, why: '没存上。' }
    }
    e.cookie = ''
    e.state = 'saved'
    pending.delete(e.key)
    return { ok: true, name: e.account?.name ?? '', note: '存下了。' }
  }

  /** 关掉 / 点取消：把这张码连同攥着的 cookie 一起忘掉。 */
  function drop(key) {
    const e = pending.get(String(key ?? ''))
    if (e) {
      e.cookie = ''
      pending.delete(e.key)
    }
    return { ok: true }
  }

  /** 插件停用时清干净（内存里的凭据不该比进程活得久）。 */
  function clear() {
    for (const e of pending.values()) e.cookie = ''
    pending.clear()
  }

  /** 只看不写：单测和自检用。 */
  function peek(key) {
    const e = pending.get(String(key ?? ''))
    return e ? { state: e.state, hasCookie: Boolean(e.cookie), account: e.account } : null
  }

  return { start, poll, save, drop, clear, peek, size: () => pending.size }
}
