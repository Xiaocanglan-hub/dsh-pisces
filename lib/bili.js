// B 站：登录（cookie）+ 只读热门 + 在视频下说一句。网络与凭据都在这里，纯函数、可注入 fetch。
//
// 四条口径（README「说话」、知识库 n23 / n64）：
// 1. bvid 不能直接发评论，要先 `/x/web-interface/view?bvid=` 拿 aid；
// 2. 凭据只从 `<root>/owner.json` 读，SESSDATA 与 bili_jct 缺任一都是"cookie 不完整"；
// 3. 登录只收 SESSDATA + bili_jct 两个键，保存前用 nav 接口验一次；0600 原子写，绝不回显；
// 4. 所有失败都不抛，折成 { ok:false, reason }，reason 只写人话、不打印 cookie。
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular'
export const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
export const REPLY_API = 'https://api.bilibili.com/x/v2/reply/add'
export const NAV_API = 'https://api.bilibili.com/x/web-interface/nav'
export const OWNER_FILE = 'owner.json'
export const OWNER_MODE = 0o600

const BVID_RE = /^BV[0-9A-Za-z]{10}$/
const SPEAK_MAX = 300
// 登录只认这两个键：SESSDATA 证明身份，bili_jct 是写操作的 csrf。
const LOGIN_KEYS = ['SESSDATA', 'bili_jct']
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const isBvid = (value) => typeof value === 'string' && BVID_RE.test(value.trim())

function safeLog(log, line) {
  if (typeof log !== 'function') return
  try {
    log(String(line))
  } catch {
    /* 日志失败不影响结果 */
  }
}

/** 从 "a=1; b=2" 里取一个 cookie 值；取不到回空串。 */
function cookieValue(cookie, name) {
  for (const part of String(cookie || '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

/**
 * 读登录态。只返回 { cookie, csrf }，csrf 就是 cookie 里的 bili_jct。
 * 文件不在 / JSON 坏 / 缺 SESSDATA 或 bili_jct 一律回 null（调用方再翻成人话）。
 * 不打印、不回显 cookie。
 */
export function readOwner(root) {
  if (!root) return null
  try {
    const file = path.join(String(root), OWNER_FILE)
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    const cookie = typeof j.cookie === 'string' ? j.cookie.trim() : ''
    if (!cookie) return null
    const sess = cookieValue(cookie, 'SESSDATA')
    const csrf = cookieValue(cookie, 'bili_jct')
    if (!sess || !csrf) return null
    return { cookie, csrf }
  } catch {
    return null
  }
}

/**
 * 从浏览器复制的整段 cookie 里只挑 SESSDATA / bili_jct，并拼回规范形状。
 * 缺哪个就说清缺哪个；换行/分号分隔都认。
 */
export function parseBiliCookie(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const values = new Map()
  for (const piece of raw.split(/[;\r\n]+/)) {
    const part = piece.trim()
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!LOGIN_KEYS.includes(key) || !value) continue
    values.set(key, value)
  }
  const missing = LOGIN_KEYS.filter((key) => !values.has(key))
  if (missing.length) return { ok: false, reason: `cookie 不完整：缺 ${missing.join('、')}` }
  return {
    ok: true,
    cookie: `SESSDATA=${values.get('SESSDATA')}; bili_jct=${values.get('bili_jct')}`,
    missing: [],
  }
}

/**
 * 读登录态（登录卡片用）：文件不在 / 坏 JSON / 缺键一律 null（调用方翻成人话）。
 * 比 readOwner 多认可选的名字与 uid；cookie 本身不回显、不打印。
 */
export function readBili(root) {
  if (!root) return null
  try {
    const file = path.join(String(root), OWNER_FILE)
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    const parsed = parseBiliCookie(typeof j.cookie === 'string' ? j.cookie : '')
    if (!parsed.ok) return null
    const at = Number(j.at)
    const out = { cookie: parsed.cookie, at: Number.isFinite(at) && at > 0 ? at : 0 }
    const name = typeof j.name === 'string' ? j.name.trim() : ''
    if (name) out.name = name
    const mid = Number(j.mid)
    if (Number.isFinite(mid) && mid > 0) out.mid = Math.trunc(mid)
    return out
  } catch {
    return null
  }
}

/** 原子写：tmp → rename，tmp 用 0600 建；失败清掉 tmp 再抛。 */
export function writeBili(root, { cookie, name, mid } = {}) {
  const parsed = parseBiliCookie(cookie)
  if (!parsed.ok) throw new Error(parsed.reason)
  if (!root) throw new Error('没有地方存')

  const file = path.join(String(root), OWNER_FILE)
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 64) : ''
  const id = Number(mid)
  const record = {
    cookie: parsed.cookie,
    name: cleanName,
    ...(Number.isFinite(id) && id > 0 ? { mid: Math.trunc(id) } : {}),
    at: Date.now(),
  }
  const text = `${JSON.stringify(record, null, 2)}\n`
  mkdirSync(path.dirname(file), { recursive: true })
  // 覆盖之前先把旧文件留成 .bak：里面是上一份登录态，点错一次只能重新扫码。
  // 备份失败不拦写盘（宁可写成功，也不能因为留副本失败就登不上）。
  try {
    if (existsSync(file)) copyFileSync(file, `${file}.bak`)
  } catch {
    /* 留不下备份就算了 */
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: OWNER_MODE })
    try {
      chmodSync(tmp, OWNER_MODE)
    } catch {
      /* Windows 不保留 POSIX 位，尽力而为 */
    }
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 没有 tmp 可清就算了 */
    }
    throw e
  }
  return record
}

/** 清掉登录文件；返回是否真的删掉了。 */
export function clearBili(root) {
  if (!root) return false
  try {
    unlinkSync(path.join(String(root), OWNER_FILE))
    return true
  } catch {
    return false
  }
}

/** nav 接口的错误码 → 人话。 */
function navReason(code) {
  if (code === -101) return '没登录'
  if (code === -412 || code === -352 || code === -403) return '被风控了'
  return `B 站回了个看不懂的（code ${code}）`
}

/**
 * 用 nav 接口验一次：`data.isLogin === true` 才算登录，顺手取 uname / mid。
 * 失败只回「没登录 / cookie 不完整 / 被风控了 / 连不上 B 站」，不打印 cookie。
 * @returns {Promise<{ok:true, name:string, mid:number}|{ok:false, reason:string}>}
 */
export async function checkBili({ cookie, fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseBiliCookie(cookie)
  if (!parsed.ok) return { ok: false, reason: 'cookie 不完整' }

  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '连不上 B 站' }

  let nav
  try {
    const res = await f(NAV_API, {
      headers: {
        'user-agent': UA,
        cookie: parsed.cookie,
        referer: 'https://www.bilibili.com/',
      },
    })
    nav = await readJson(res)
  } catch {
    return { ok: false, reason: '连不上 B 站' }
  }
  if (!nav || typeof nav !== 'object') return { ok: false, reason: '连不上 B 站' }

  const code = Number(nav.code)
  if (code !== 0) return { ok: false, reason: navReason(code) }
  // code 0 也可能是"没登录"：没有有效 SESSDATA 时 web 端回 isLogin:false。
  if (nav.data?.isLogin !== true) return { ok: false, reason: '没登录' }

  const name = typeof nav.data?.uname === 'string' ? nav.data.uname.trim() : ''
  const mid = Number(nav.data?.mid)
  return { ok: true, name, mid: Number.isFinite(mid) && mid > 0 ? Math.trunc(mid) : 0 }
}

/**
 * 粘贴 → 解析 → 验证 → 写盘。验证不过一个字节都不写。
 * @returns {Promise<{ok:true, name:string}|{ok:false, reason:string}>}
 */
export async function loginBili({ root, text, fetchImpl = globalThis.fetch, log } = {}) {
  if (!root) return { ok: false, reason: '没有地方存' }
  const parsed = parseBiliCookie(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const chk = await checkBili({ cookie: parsed.cookie, fetchImpl })
  if (!chk.ok) return chk

  try {
    writeBili(root, { cookie: parsed.cookie, name: chk.name, mid: chk.mid })
  } catch {
    return { ok: false, reason: '存不进去' }
  }
  safeLog(log, 'B 站登录：已保存（只在本机）')
  return { ok: true, name: chk.name }
}

async function readJson(res) {
  try {
    if (!res || typeof res.json !== 'function') return null
    return await res.json()
  } catch {
    return null
  }
}

/** view 接口的错误码 → 人话。 */
function viewReason(code) {
  if (code === -404 || code === -400 || code === 62002 || code === 62004) return '找不到这个视频'
  if (code === -101) return '没登录'
  if (code === -412 || code === -352 || code === -403) return '被风控了'
  return `视频信息没拿到（code ${code}）`
}

/** 发评论接口的错误码 → 人话。 */
function replyReason(code) {
  if (code === -101) return '没登录'
  if (code === -111) return 'cookie 里的 csrf 不对'
  if (code === -412 || code === -352 || code === -403) return '被风控了'
  if (code === 12051 || code === -509 || code === 12009) return '评论太频繁'
  if (code === 12002) return '这条视频不能评论'
  if (code === -400) return '请求被拒了（可能太频繁）'
  return `评论没发出去（code ${code}）`
}

/**
 * bvid → aid（发评论要 aid，bvid 不能直接发）。
 * 形状不对直接拒，一个请求都不发。
 * @returns {Promise<{ok:true, aid:number}|{ok:false, reason:string}>}
 */
export async function bvidToAid(bvid, { fetchImpl, log } = {}) {
  const id = typeof bvid === 'string' ? bvid.trim() : ''
  if (!isBvid(id)) return { ok: false, reason: 'bvid 不像 bvid' }

  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '没有可用的网络' }

  try {
    const url = `${VIEW_API}?bvid=${encodeURIComponent(id)}`
    const res = await f(url, {
      headers: {
        'user-agent': UA,
        referer: `https://www.bilibili.com/video/${id}/`,
      },
    })
    const j = await readJson(res)
    if (!j || typeof j !== 'object') return { ok: false, reason: 'B 站回了个看不懂的' }
    const code = Number(j.code)
    if (code !== 0) {
      const reason = viewReason(code)
      safeLog(log, `B 站查视频失败：${reason}`)
      return { ok: false, reason }
    }
    const aid = Number(j.data?.aid)
    if (!Number.isFinite(aid) || aid <= 0) return { ok: false, reason: '找不到这个视频' }
    return { ok: true, aid }
  } catch {
    safeLog(log, 'B 站查视频失败：连不上')
    return { ok: false, reason: '连不上 B 站' }
  }
}

/**
 * 看一眼首页热门（只读公开接口，不登录、不发东西）。
 * @returns {Promise<{ok:true, items:Array<{bvid,title,owner,view}>}|{ok:false, reason:string}>}
 */
export async function hot({ limit = 5, fetchImpl = globalThis.fetch } = {}) {
  const n = Math.max(1, Math.min(10, Math.trunc(Number(limit)) || 5))
  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '没有可用的网络' }

  try {
    const res = await f(POPULAR_API, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    })
    const j = await readJson(res)
    if (!j || typeof j !== 'object') return { ok: false, reason: 'B 站回了个看不懂的' }
    const code = Number(j.code)
    if (code !== 0) return { ok: false, reason: `没看成热门（code ${code}）` }
    const list = Array.isArray(j.data?.list) ? j.data.list : []
    const items = list.slice(0, n).map((v) => ({
      bvid: typeof v?.bvid === 'string' ? v.bvid : '',
      title: String(v?.title ?? ''),
      owner: String(v?.owner?.name ?? ''),
      view: Number(v?.stat?.view) || 0,
    }))
    return { ok: true, items }
  } catch {
    return { ok: false, reason: '连不上 B 站' }
  }
}

/**
 * 在视频下说一句。两步：先拿 aid，再 POST 表单。
 * 说出去收不回来；所有失败都折成 { ok:false, reason }。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function postComment({ root, bvid, text, cfg = {}, fetchImpl, now = Date.now(), log } = {}) {
  const message = typeof text === 'string' ? text : ''
  if (!message.trim()) return { ok: false, reason: '没话可说' }
  if (message.length > SPEAK_MAX) return { ok: false, reason: '太长了' }

  const id = typeof bvid === 'string' ? bvid.trim() : ''
  if (!isBvid(id)) return { ok: false, reason: 'bvid 不像 bvid' }

  if (!root) return { ok: false, reason: '没登录' }
  let hasFile = false
  try {
    hasFile = existsSync(path.join(String(root), OWNER_FILE))
  } catch {
    hasFile = false
  }
  const owner = readOwner(root)
  if (!owner) return { ok: false, reason: hasFile ? 'cookie 不完整' : '没登录' }

  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '没有可用的网络' }

  try {
    const found = await bvidToAid(id, { fetchImpl: f, log })
    if (!found.ok) return { ok: false, reason: found.reason }

    const body = new URLSearchParams({
      oid: String(found.aid),
      type: '1',
      message,
      csrf: owner.csrf,
    })
    const res = await f(REPLY_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': UA,
        cookie: owner.cookie,
        referer: `https://www.bilibili.com/video/${id}/`,
        origin: 'https://www.bilibili.com',
      },
      body: body.toString(),
    })
    const j = await readJson(res)
    if (!j || typeof j !== 'object') return { ok: false, reason: 'B 站回了个看不懂的' }
    const code = Number(j.code)
    if (code === 0) return { ok: true }
    const reason = replyReason(code)
    safeLog(log, `B 站说话失败：${reason}`)
    return { ok: false, reason }
  } catch {
    safeLog(log, 'B 站说话失败：连不上')
    return { ok: false, reason: '连不上 B 站' }
  }
}
