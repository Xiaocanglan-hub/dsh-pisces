// 老数据迁移：已经有鱼（demo / seed）但没有 setup.json 时，按现有鱼补一个开局。
// 不伪造事件、不改鱼；只决定 mode。
import { isDemo } from './adopt.js'
import { seedOf } from './seed.js'
import { createSetup } from './setup.js'

/**
 * @param {object[]} events
 * @returns {Readonly<object> | null} null = 空库，还轮不到迁移
 */
export function inferSetup(events = []) {
  const list = Array.isArray(events) ? events : []
  if (isDemo(list)) return createSetup({ mode: 'pisces' })
  if (seedOf(list)) return createSetup({ mode: 'sister' })
  return null
}

/** 有 setup 就原样；没有就按现有鱼补；空库返回 null（不写）。 */
export function migrateSetup({ root, events, read, write }) {
  const current = typeof read === 'function' ? read(root) : null
  if (current) return { ok: true, setup: current, migrated: false }
  const inferred = inferSetup(events)
  if (!inferred) return { ok: true, setup: null, migrated: false }
  if (typeof write === 'function') write(root, inferred)
  return { ok: true, setup: inferred, migrated: true }
}
