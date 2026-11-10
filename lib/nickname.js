// 昵称：他给的称呼，她拿来自称。
//
// 三条口径（知识库 n61 / docs「昵称」一节）：
// 1. 固定名字不变：她仍然是派希丝/大肥鱼，昵称只是"他平时怎么叫她"。
// 2. 不另存配置：昵称是一条 `type:'meta'`、`meta.kind:'nickname'` 的事件，只追加、不覆盖；
//    改昵称 = 再追加一条，永远取最后一条。
// 3. 校验与写入口只是纯函数 + 一次 append，不 import 宿主、不碰 @deepseek-ai/*。

export const NICKNAME_MAX = 12

/** 固定名字：这两个是"她本来就叫的"，不能拿来当昵称。 */
export const FIXED_NAMES = ['派希丝', '大肥鱼']

const CONTROL = /[\u0000-\u001f\u007f]/

/** 一条事件是不是昵称事件；顺手验一下名字非空。 */
function nicknameEvent(e) {
  if (!e || !e.meta || e.meta.kind !== 'nickname') return null
  const name = typeof e.meta.name === 'string' ? e.meta.name.trim() : ''
  return name ? { name, at: Number(e.ts) || 0, seq: e.seq ?? null } : null
}

/**
 * 事件流里最后一条昵称；没有就 null。
 * @param {Array<object>} events
 * @returns {{name:string, at:number, seq:number|null}|null}
 */
export function nicknameOf(events = []) {
  let hit = null
  for (const e of Array.isArray(events) ? events : []) {
    const n = nicknameEvent(e)
    if (n) hit = n
  }
  return hit
}

/**
 * 只校验名字本身（不读事件流，所以不知道当前昵称）。
 * 去首尾空白；1–12 个字符；不能为空；不能含换行/控制字符；不能是固定名字。
 * @returns {{ok:true, name:string} | {ok:false, reason:string}}
 */
export function validateNickname(text) {
  if (typeof text !== 'string') return { ok: false, reason: '昵称要是文字' }
  const name = text.trim()
  if (!name) return { ok: false, reason: '昵称不能为空' }
  if ([...name].length > NICKNAME_MAX) return { ok: false, reason: `昵称最多 ${NICKNAME_MAX} 个字` }
  if (CONTROL.test(name)) return { ok: false, reason: '昵称不能有换行或控制字符' }
  if (FIXED_NAMES.includes(name)) return { ok: false, reason: '这本来就是我的名字' }
  return { ok: true, name }
}

/**
 * 记一个昵称：追加一条 meta 事件，不覆盖旧的。
 * @param {{store:object, name:string, now?:number}} args
 * @returns {Promise<{ok:true, name:string, event:object} | {ok:false, reason:string}>}
 */
export async function setNickname({ store, name, now = Date.now() } = {}) {
  const v = validateNickname(name)
  if (!v.ok) return { ok: false, reason: v.reason }

  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }
  // 跟现在的昵称一样也是"这本来就是我的名字"：没必要为同一个名字再写一条。
  const current = nicknameOf(events)
  if (current && current.name === v.name) return { ok: false, reason: '这本来就是我的名字' }

  try {
    const event = await store.append({
      ts: now,
      type: 'meta',
      text: `nickname:${v.name}`,
      meta: { kind: 'nickname', name: v.name },
      source: 'owner',
    })
    return { ok: true, name: v.name, event }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) }
  }
}
