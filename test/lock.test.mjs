import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { acquire, release, readLock, LOCK_TTL_MS } from '../lib/lock.js'

const lockFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'pisces-lock-')), 'lock.json')

test('锁：先到先得，第二个实例被挡；释放后能再抢', () => {
  const f = lockFile()
  const a = acquire(f, { now: 1000, pid: 111 })
  assert.equal(a.ok, true)
  assert.equal(readLock(f).token, a.token)
  const b = acquire(f, { now: 1500, pid: 222 })
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'locked')
  assert.equal(b.holder.pid, 111)
  assert.equal(release(f, 'wrong-token'), false)
  assert.equal(release(f, a.token), true)
  assert.equal(acquire(f, { now: 2000, pid: 222 }).ok, true)
})

test('锁：同一个 pid 可以重入；过期的陈锁可以接管', () => {
  const f = lockFile()
  const a = acquire(f, { now: 1000, pid: 111 })
  assert.equal(acquire(f, { now: 1100, pid: 111 }).ok, true)
  const stale = acquire(f, { now: 1100 + LOCK_TTL_MS + 1, pid: 222 })
  assert.equal(stale.ok, true)
  assert.notEqual(stale.token, a.token)
})
