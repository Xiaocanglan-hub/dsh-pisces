// B 站：只读热门 + 在视频下说一句。网络与凭据都在这里，纯函数、可注入 fetch。
//
// 三条口径（README「说话」、知识库 n23）：
// 1. bvid 不能直接发评论，要先 `/x/web-interface/view?bvid=` 拿 aid；
// 2. 凭据只从 `<root>/owner.json` 读，SESSDATA 与 bili_jct 缺任一都是"cookie 不完整"；
// 3. 所有失败都不抛，折成 { ok:false, reason }，reason 只写人话、不打印 cookie。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const POPULAR_API = 'https://api.bilibili.com/x/web-interface/popular'
export const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'
export const REPLY_API = 'https://api.bilibili.com/x/v2/reply/add'
export const OWNER_FILE = 'owner.json'

const BVID_RE = /^BV[0-9A-Za-z]{10}$/
const SPEAK_MAX = 300
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
