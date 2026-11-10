// 百度贴吧登录：只收 BDUSS + STOKEN，保存时用贴吧接口验一次。
//
// 三条口径：
// 1. 只认 BDUSS、STOKEN 两个键，别的键一律丢掉；缺任一都是"cookie 不完整"。
// 2. 凭据存 `<root>/baidu.json`，0600 原子写（tmp → rename）；读坏文件回 null。
// 3. 所有失败都不抛，折成 { ok:false, reason }；reason 只写人话，任何日志都不打印 cookie。
import fs from 'node:fs'
import path from 'node:path'

export const BAIDU_FILE = 'baidu.json'
export const BAIDU_MODE = 0o600
export const TBS_API = 'https://tieba.baidu.com/dc/common/tbs'
export const USERINFO_API = 'https://tieba.baidu.com/f/user/json_userinfo'

const COOKIE_KEYS = ['BDUSS', 'STOKEN']
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 从浏览器复制的整段 cookie 里只挑 BDUSS / STOKEN，并拼回规范形状。 */
export function parseBaiduCookie(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const values = new Map()
  for (const piece of raw.split(/[;\r\n]+/)) {
    const part = piece.trim()
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!COOKIE_KEYS.includes(key) || !value) continue
    values.set(key, value)
  }
  const missing = COOKIE_KEYS.filter((key) => !values.has(key))
  if (missing.length) return { ok: false, reason: `cookie 不完整：缺 ${missing.join('、')}` }
  return {
    ok: true,
    cookie: `BDUSS=${values.get('BDUSS')}; STOKEN=${values.get('STOKEN')}`,
    missing: [],
  }
}

/**
 * 读登录态：坏文件 / 不是对象 / 缺键一律 null（调用方翻成人话）。
 * 不打印、不回显 cookie。
 */
export function readBaidu(root) {
  if (!root) return null
  try {
    const raw = fs.readFileSync(path.join(String(root), BAIDU_FILE), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    const parsed = parseBaiduCookie(typeof j.cookie === 'string' ? j.cookie : '')
    if (!parsed.ok) return null
    const at = Number(j.at)
    const out = { cookie: parsed.cookie, at: Number.isFinite(at) && at > 0 ? at : 0 }
    const name = typeof j.name === 'string' ? j.name.trim() : ''
    if (name) out.name = name
    return out
  } catch {
    return null
  }
}

/** 原子写：tmp → rename，tmp 用 0600 建；失败清掉 tmp 再抛。 */
export function writeBaidu(root, { cookie, name } = {}) {
  const parsed = parseBaiduCookie(cookie)
  if (!parsed.ok) throw new Error(parsed.reason)
  if (!root) throw new Error('没有地方存')

  const file = path.join(String(root), BAIDU_FILE)
  const cleanName = typeof name === 'string' ? name.trim().slice(0, 64) : ''
  const record = { cookie: parsed.cookie, name: cleanName, at: Date.now() }
  const text = `${JSON.stringify(record, null, 2)}\n`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: BAIDU_MODE })
    try {
      fs.chmodSync(tmp, BAIDU_MODE)
    } catch {
      /* Windows 不保留 POSIX 位，尽力而为 */
    }
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, BAIDU_MODE)
    } catch {
      /* 同上 */
    }
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 没有 tmp 可清就算了 */
    }
    throw e
  }
  return { cookie: record.cookie, name: cleanName, at: record.at }
}

/** 清掉登录文件；返回是否真的删掉了。 */
export function clearBaidu(root) {
  if (!root) return false
  try {
    fs.unlinkSync(path.join(String(root), BAIDU_FILE))
    return true
  } catch {
    return false
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

/**
 * 用贴吧接口验一次：tbs 的 is_login===1 算登录，再尽量取 user_name。
 * 失败只回「没登录 / cookie 不完整 / 连不上贴吧」，不打印 cookie。
 * @returns {Promise<{ok:true, name:string}|{ok:false, reason:string}>}
 */
export async function checkBaidu({ cookie, fetchImpl = globalThis.fetch } = {}) {
  const parsed = parseBaiduCookie(cookie)
  if (!parsed.ok) return { ok: false, reason: 'cookie 不完整' }

  const f = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof f !== 'function') return { ok: false, reason: '连不上贴吧' }

  let tbs
  try {
    const res = await f(TBS_API, {
      headers: {
        'user-agent': UA,
        cookie: parsed.cookie,
        referer: 'https://tieba.baidu.com/',
      },
    })
    tbs = await readJson(res)
  } catch {
    return { ok: false, reason: '连不上贴吧' }
  }
  if (!tbs || typeof tbs !== 'object') return { ok: false, reason: '连不上贴吧' }
  if (Number(tbs.is_login) !== 1) return { ok: false, reason: '没登录' }

  // 名字是可选信息：拿不到就回空串，不影响"登上了"这个结论。
  let name = ''
  try {
    const res = await f(USERINFO_API, {
      headers: {
        'user-agent': UA,
        cookie: parsed.cookie,
        referer: 'https://tieba.baidu.com/',
      },
    })
    const info = await readJson(res)
    const raw = info?.data?.user_name ?? info?.user_name
    if (typeof raw === 'string') name = raw.trim()
  } catch {
    name = ''
  }
  return { ok: true, name }
}

/**
 * 粘贴 → 解析 → 验证 → 写盘。验证不过一个字节都不写。
 * @returns {Promise<{ok:true, name:string}|{ok:false, reason:string}>}
 */
export async function loginBaidu({ root, text, fetchImpl = globalThis.fetch } = {}) {
  if (!root) return { ok: false, reason: '没有地方存' }
  const parsed = parseBaiduCookie(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }

  const chk = await checkBaidu({ cookie: parsed.cookie, fetchImpl })
  if (!chk.ok) return chk

  try {
    writeBaidu(root, { cookie: parsed.cookie, name: chk.name })
  } catch {
    return { ok: false, reason: '存不进去' }
  }
  return { ok: true, name: chk.name }
}
