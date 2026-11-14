// 单实例锁：抢到的人写事件，其他人只读。
// 锁文件里放 {pid, token, ts}；超过 TTL 视为陈锁，可以接管。
// Windows 上被占用时 rename 会失败，所以先写 tmp 再 rename，失败清掉 tmp。
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const LOCK_TTL_MS = 30_000

/** pid 还在不在。Windows 上 process.kill(pid, 0) 对死进程抛 ESRCH。 */
function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

export function readLock(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'))
  } catch {
    return null
  }
}

/** @returns {{ok:true,token:string}|{ok:false,reason:string,holder:object|null}} */
export function acquire(lockFile, {
  now = Date.now(),
  ttl = LOCK_TTL_MS,
  pid = process.pid,
  isAlive = pidAlive,
} = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true })
  const token = randomBytes(8).toString('hex')
  const cur = readLock(lockFile)
  const mine = cur && Number(cur.pid) === Number(pid) && cur.token
  // 陈锁：超过 TTL，或持有进程已经死了（崩溃/强杀留下的 lock.json）。
  const stale = !cur
    || !Number(cur.ts)
    || now - Number(cur.ts) >= ttl
    || !isAlive(cur.pid)
  if (cur && !mine && !stale) {
    return { ok: false, reason: 'locked', holder: cur }
  }
  const tmp = `${lockFile}.${pid}.${now}.tmp`
  writeFileSync(tmp, JSON.stringify({ pid, token, ts: now }), 'utf8')
  try {
    renameSync(tmp, lockFile)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
  return { ok: true, token }
}

export function release(lockFile, token) {
  const cur = readLock(lockFile)
  if (cur && token && cur.token === token) {
    try { unlinkSync(lockFile) } catch {}
    return true
  }
  return false
}
