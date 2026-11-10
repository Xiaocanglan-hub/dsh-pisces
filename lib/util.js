// 小工具：id、hash、日期、裁剪。lib 里所有人共用，不许依赖别的 lib 模块。
import { createHash, randomBytes } from 'node:crypto'

export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID：10 位时间 + 16 位随机，Crockford base32；同一个毫秒里也不撞。 */
export function ulid(now = Date.now()) {
  let t = Math.max(0, Number(now) || 0)
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32]
  return time + rand
}

export const newEventId = (now = Date.now()) => `ev_${ulid(now)}`

/** 本地日：YYYY-MM-DD。事件、日记、派生天数都用它。 */
export function dayOf(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 压成一行、按字符截断。只给"给人看"的地方用，不拿去当证据。 */
export function clip(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
}

export const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

export const sleep = (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0))
