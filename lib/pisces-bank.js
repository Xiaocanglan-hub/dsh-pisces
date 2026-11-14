// 第二个库：选项 3“一同成长=是”时，派希丝自己的事件库。
// 独立于普通鱼主库；只记客厅里她那条线，不建第二个 home/session。
import { join } from 'node:path'
import { createStore } from './store.js'
import { getCast } from './cast.js'

export const PISCES_BANK_DIR = 'banks/pisces'

export function piscesBankRoot(root) {
  return join(String(root ?? ''), 'banks', 'pisces')
}

export async function openPiscesBank(root, { log = () => {} } = {}) {
  return createStore({ root: piscesBankRoot(root), log })
}

/** 只留成年鱼那段；普通鱼的句子不进她的库。名字按 cast 走（n192）。 */
function piscesPart(text) {
  const s = String(text ?? '')
  const marker = `【${getCast().adult.name}】`
  const i = s.indexOf(marker)
  if (i >= 0) return s.slice(i + marker.length).trim()
  return s.trim()
}

/**
 * 客厅一轮写进派希丝库：owner 的 heard + 她自己的 utterance（可选 teaching）。
 * 失败只回 ok:false，不抛；调用方自己决定 log。
 */
export async function recordRoomInBank(store, { user = '', text = '', teaching = null } = {}) {
  if (!store || typeof store.append !== 'function') return { ok: false, reason: '没有派希丝库' }
  const wrote = []
  try {
    const body = String(user ?? '').trim()
    if (body) {
      wrote.push(await store.append({
        type: 'heard',
        source: 'owner',
        text: body,
        meta: { kind: 'chat', via: 'room-bank' },
      }))
    }
    const mine = piscesPart(text)
    if (mine) {
      wrote.push(await store.append({
        type: 'utterance',
        source: 'agent',
        text: mine,
        meta: { kind: 'chat', via: 'room-bank', speaker: 'pisces' },
      }))
    }
    if (teaching?.id) {
      wrote.push(await store.append({
        type: 'teaching',
        source: 'agent',
        text: String(text || ''),
        meta: { kind: 'teaching', lessonId: String(teaching.id), via: 'room-bank' },
      }))
    }
    return { ok: true, count: wrote.length }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}
