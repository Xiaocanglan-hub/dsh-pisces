// 客厅共享日志（2026-11-13，n192/按 2 改）：
// - 每轮客厅只写一份 room-log.jsonl（用户 + 两条鱼各自的话），不再按轮写各自的库。
// - 各自的库在夜间/派生时从这份日志吸收；吸收什么由 decide/模型判断。
// - 日志是“两条鱼都看得到”的事实层；库是“她自己记得”的判断层。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCast } from './cast.js'

export const ROOM_LOG_FILE = 'room-log.jsonl'
export const ROOM_CURSOR_KEY = 'room.absorbed'

const CUR = ROOM_CURSOR_KEY

function logPath(root) {
  return join(String(root ?? ''), ROOM_LOG_FILE)
}

function kvGet(store, key) {
  if (typeof store?.modeGet === 'function') return store.modeGet(key)
  if (typeof store?.metaGet === 'function') return store.metaGet(key)
  return null
}

function kvSet(store, key, value) {
  if (typeof store?.modeSet === 'function') return store.modeSet(key, value)
  if (typeof store?.metaSet === 'function') return store.metaSet(key, value)
  return null
}

/** 追加一轮客厅；空的轮不写。返回写进去的行，失败回 null（不抛）。 */
export function appendRoomLog(root, entry = {}) {
  if (!root) return null
  const row = {
    at: Number(entry.at) || Date.now(),
    user: String(entry.user ?? '').trim(),
    fish: String(entry.fish ?? '').trim(),
    pisces: String(entry.pisces ?? '').trim(),
    teaching: entry.teaching ? String(entry.teaching) : null,
  }
  if (!row.user && !row.fish && !row.pisces) return null
  try {
    mkdirSync(root, { recursive: true })
    appendFileSync(logPath(root), `${JSON.stringify(row)}\n`, 'utf8')
    return row
  } catch {
    return null
  }
}

/** 读日志；每条带 _i（行号，给吸收游标用）。坏行跳过，不抛。 */
export function readRoomLog(root, { after = -1, limit = 500 } = {}) {
  const fallback = { entries: [], next: after }
  if (!root) return fallback
  try {
    if (!existsSync(logPath(root))) return fallback
    const lines = readFileSync(logPath(root), 'utf8').split('\n').filter((l) => l.trim())
    const entries = []
    for (let i = Math.max(0, after + 1); i < lines.length && entries.length < limit; i++) {
      try {
        entries.push({ ...JSON.parse(lines[i]), _i: i })
      } catch {
        /* 坏行跳过 */
      }
    }
    return { entries, next: lines.length - 1 }
  } catch {
    return fallback
  }
}

/**
 * 把日志吸收进各自的库（客厅是「派希丝教鲸歌」的地方，所以**两边都收**）：
 * - 用户那句：两边各写一条 heard；
 * - 她自己说的：写 utterance（只写自己那句）；
 * - 对方说的：写 type:'room'，meta.speaker 标明是谁——它既不是「她说的」，也不是「主人说的」，
 *   检索能翻到，但归因/信念不会把它当她的原话。
 * - 判断：decide({ entry, role, who, model }) 返回一句她额外想记的（可为空），
 *   由调用方决定要不要接模型；不接就只走基线。
 * 每个库有自己的游标（room.absorbed），重复调用不会重复吸收。
 */
export async function absorbRoomLog({ root, stores = [], decide = null, now = Date.now() } = {}) {
  const { entries, next } = readRoomLog(root)
  if (!entries.length) return { ok: true, absorbed: 0, recorded: 0, next }
  const cast = getCast()
  let absorbed = 0
  let recorded = 0
  for (const item of stores) {
    const store = item?.store
    const role = item?.role === 'adult' ? 'adult' : 'ordinary'
    if (!store || typeof store.append !== 'function') continue
    const cursorRaw = kvGet(store, CUR)
    const cursor = cursorRaw == null ? -1 : Number(cursorRaw)
    const from = Number.isFinite(cursor) ? cursor : -1
    const fresh = entries.filter((e) => Number(e._i) > from)
    if (!fresh.length) continue
    const who = cast[role] || cast.ordinary
    const peerRole = role === 'adult' ? 'ordinary' : 'adult'
    for (const e of fresh) {
      const mine = role === 'adult' ? e.pisces : e.fish
      const peer = role === 'adult' ? e.fish : e.pisces
      try {
        if (e.user) {
          await store.append({
            type: 'heard',
            source: 'owner',
            text: e.user,
            meta: { kind: 'chat', via: 'room-log' },
          })
          recorded++
        }
        if (mine) {
          await store.append({
            type: 'utterance',
            source: 'agent',
            text: mine,
            meta: { kind: 'chat', via: 'room-log', speaker: role },
          })
          recorded++
        }
        if (peer) {
          await store.append({
            type: 'room',
            source: 'agent',
            text: peer,
            meta: { kind: 'room-line', via: 'room-log', speaker: peerRole },
          })
          recorded++
        }
        if (typeof decide === 'function') {
          const extra = await decide({ entry: e, role, who, model: item?.model || null })
          const text = String(extra ?? '').trim()
          if (text) {
            await store.append({
              type: 'note',
              source: 'agent',
              text,
              meta: { kind: 'room-note', via: 'nightly', speaker: role },
            })
            recorded++
          }
        }
      } catch {
        /* 单条失败不拖垮整批 */
      }
    }
    kvSet(store, CUR, next)
    absorbed += fresh.length
  }
  return { ok: true, absorbed, recorded, next, at: Number(now) || Date.now() }
}
