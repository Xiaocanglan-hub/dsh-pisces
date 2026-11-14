// 读 <root>/cast.json。没有、坏了、不是对象都回 null（= 用发布 cast）。
// 只在非发布版读；发布版在 index.js 里直接跳过。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeCast } from './cast.js'

export function readCastFile(root) {
  if (!root) return null
  try {
    const raw = readFileSync(join(root, 'cast.json'), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return normalizeCast(parsed)
  } catch {
    return null
  }
}
