// 数据目录解析：三条来源，优先级从高到低。
//   1. 环境变量 DSH_PISCES_HOME
//   2. 指针文件 ~/.dsh-pisces-location.json 的 { "root": "..." }
//   3. 默认 ~/.dsh-pisces
// 与 dsh-fish 的 store.js 同一套思路，但键名与目录名换成 pisces。
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const POINTER_NAME = '.dsh-pisces-location.json'
export const DEFAULT_DIR_NAME = '.dsh-pisces'

export function homeDir(env = process.env) {
  const h = env.USERPROFILE || env.HOME || ''
  return h && String(h).trim() ? path.resolve(h) : homedir()
}

export function pointerPath(env = process.env) {
  return path.join(homeDir(env), POINTER_NAME)
}

function readPointer(env) {
  try {
    const raw = readFileSync(pointerPath(env), 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (j && typeof j.root === 'string' && j.root.trim()) return path.resolve(j.root.trim())
  } catch {
    /* 没有指针、坏 JSON、没权限：都退回默认 */
  }
  return null
}

export function resolveRoot(env = process.env) {
  const explicit = String(env.DSH_PISCES_HOME || '').trim()
  if (explicit) return path.resolve(explicit)
  const fromPointer = readPointer(env)
  if (fromPointer) return fromPointer
  return path.join(homeDir(env), DEFAULT_DIR_NAME)
}

export function paths(root) {
  const base = path.resolve(root)
  return {
    root: base,
    events: path.join(base, 'events.db'),
    world: path.join(base, 'world.db'),
    index: path.join(base, 'index.db'),
    eventsJsonl: path.join(base, 'events.jsonl'),
    diaryDir: path.join(base, 'diary'),
    backupDir: path.join(base, 'backup'),
    lockFile: path.join(base, 'lock.json'),
    configFile: path.join(base, 'config.json'),
  }
}

export function ensureDirs(root) {
  const p = paths(root)
  mkdirSync(p.root, { recursive: true })
  mkdirSync(p.diaryDir, { recursive: true })
  mkdirSync(p.backupDir, { recursive: true })
  return p
}

// 原子写指针：tmp → rename。Windows 上被占用时重试几次。
export function writePointer(root, env = process.env) {
  const target = pointerPath(env)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify({ root: path.resolve(root), at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  try {
    renameSync(tmp, target)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
  return target
}
