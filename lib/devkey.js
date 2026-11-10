// 开发者钥匙：只存 sha256，明文只在生成/重置那一刻给一次。
//
// 三条口径：
// 1. 文件是 `<root>/devkey.json`，0600 原子写；里面只有 `hash` / `created` / `rev`，
//    永远没有明文。`GET /devkey` 只回 `{hasKey}`。
// 2. 钥匙 16 位，字母表去掉易混字符 0/O/1/I；展示分三组，校验时忽略 `-` 与大小写。
// 3. 任何读失败（文件不存在、坏 JSON、没有 hash）都当"没有钥匙"，不抛。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEVKEY_FILE = 'devkey.json'
export const DEVKEY_LEN = 16
// 32 个字符：数字 2–9 + 大写字母去掉 I/O。去掉 0/O/1/I 之后手抄不容易错。
export const DEVKEY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const DEVKEY_MODE = 0o600

/** 钥匙文件位置。 */
export function devkeyPath(root) {
  return path.join(String(root), DEVKEY_FILE)
}

/** 规范化：去掉所有 `-` 与空白，再转大写。校验/哈希都走它。 */
export function normalizeDevkey(key) {
  return String(key ?? '')
    .replace(/[-\s]/g, '')
    .toUpperCase()
}

/** sha256(规范化后的 key) → hex。 */
function hashOf(key) {
  return crypto.createHash('sha256').update(normalizeDevkey(key)).digest('hex')
}

/** 16 位随机 key，展示成三组（5-5-6）；字母表里没有 0/O/1/I。 */
function generateKey() {
  const bytes = crypto.randomBytes(DEVKEY_LEN)
  const chars = []
  for (let i = 0; i < DEVKEY_LEN; i++) chars.push(DEVKEY_ALPHABET[bytes[i] % DEVKEY_ALPHABET.length])
  const raw = chars.join('')
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10)}`
}

/** 读记录；坏文件 / 缺 hash 一律 null。 */
function readRecord(root) {
  if (!root) return null
  try {
    const raw = fs.readFileSync(devkeyPath(root), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null
    if (typeof j.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(j.hash)) return null
    return {
      hash: j.hash.toLowerCase(),
      created: Number(j.created) || 0,
      rev: Number(j.rev) || 0,
    }
  } catch {
    return null
  }
}

/** 0600 原子写：tmp → rename；Windows 不保留 POSIX 位时尽力而为。 */
function writeRecord(root, record) {
  const file = devkeyPath(root)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = `${JSON.stringify(record, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: DEVKEY_MODE })
    try {
      fs.chmodSync(tmp, DEVKEY_MODE)
    } catch {
      /* Windows 上 chmod 基本无效，尽力而为 */
    }
    fs.renameSync(tmp, file)
    try {
      fs.chmodSync(file, DEVKEY_MODE)
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
}

/**
 * 没有就生成。第一次生成时把明文 key 一并返回一次；已有就只回 `{created:false}`。
 * @returns {{created:boolean, key?:string}}
 */
export function ensureDevkey(root) {
  if (!root) return { created: false }
  if (readRecord(root)) return { created: false }
  const key = generateKey()
  writeRecord(root, { hash: hashOf(key), created: Date.now(), rev: 1 })
  return { created: true, key }
}

/**
 * 生成一把新的、覆盖旧的；旧 key 立刻失效。
 * 明文只在这里返回一次。
 * @returns {{key:string}}
 */
export function rotateDevkey(root) {
  const prev = readRecord(root)
  const key = generateKey()
  writeRecord(root, {
    hash: hashOf(key),
    created: prev?.created || Date.now(),
    rev: (prev?.rev || 0) + 1,
  })
  return { key }
}

/** 比对 sha256；文件不存在 / 形状不对 / key 长度不对都是 false。 */
export function verifyDevkey(root, key) {
  const rec = readRecord(root)
  if (!rec) return false
  const k = normalizeDevkey(key)
  if (k.length !== DEVKEY_LEN) return false
  const got = Buffer.from(hashOf(k), 'hex')
  const want = Buffer.from(rec.hash, 'hex')
  if (got.length !== want.length) return false
  return crypto.timingSafeEqual(got, want)
}

/** 有没有钥匙文件（不校验内容之外的任何东西）。 */
export function hasDevkey(root) {
  return Boolean(readRecord(root))
}

/** 删掉钥匙文件；返回是否真的删掉了。 */
export function deleteDevkey(root) {
  if (!root) return false
  try {
    fs.unlinkSync(devkeyPath(root))
    return true
  } catch {
    return false
  }
}

/**
 * 事件流里最后一条 dev-persona 的正文；`meta.text` 为 null（clear）或没有记录 → null。
 * 只读，不改事件。
 */
export function devOverlayOf(events = []) {
  let last = null
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.meta?.kind === 'dev-persona') last = e
  }
  if (!last) return null
  const text = last.meta?.text
  return typeof text === 'string' && text.trim() ? text : null
}
