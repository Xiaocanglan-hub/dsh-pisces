// setup.json：开局三选项的状态，放在数据根下。
// 只存规则字段；banks/room/locked 这些派生值读取时由 createSetup 重建，不写盘。
import fs from 'node:fs'
import path from 'node:path'
import { SETUP_MODES, createSetup } from './setup.js'

export const SETUP_FILE = 'setup.json'

export function setupPath(root) {
  return path.join(String(root ?? ''), SETUP_FILE)
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/** 读不到 / 坏 JSON / mode 不合法 → null；不抛。 */
export function readSetup(root) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(setupPath(root), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!isPlainObject(raw) || !SETUP_MODES.includes(raw.mode)) return null
  let base
  try {
    base = createSetup({
      mode: raw.mode,
      together: raw.together === true,
      now: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    })
  } catch {
    return null
  }
  return Object.freeze({
    ...base,
    addedSister: raw.addedSister === true,
    roomWelcomeSent: raw.roomWelcomeSent === true,
  })
}

/** 原子写；只写规则字段。失败清 tmp 再抛。 */
export function writeSetup(root, setup) {
  if (!setup || !SETUP_MODES.includes(setup.mode)) throw new Error('setup 不合法')
  const file = setupPath(root)
  const data = {
    mode: setup.mode,
    together: setup.together === true,
    addedSister: setup.addedSister === true,
    roomWelcomeSent: setup.roomWelcomeSent === true,
    createdAt: Number(setup.createdAt) || Date.now(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* 没有 tmp 可清 */ }
    throw e
  }
  return { ok: true, path: file }
}
