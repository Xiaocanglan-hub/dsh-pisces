// 她自己想起一个问题（自学的前置）：她目前的"问题"几乎全是问主人的（kind:'to-you'），
// 自学那边按规矩不查这类——于是那颗能力一直空转。这里补的是"世界类"问题：
// 只问关于世界的事，不问你也不问他；用本地模型生成，最多七天一句，落进问题表后由 learn 去查。
//
// 边界：
// - 只在有模型时才跑；没有模型就安静跳过（不编问题）。
// - 只存一句、只标 source:'wonder'，不改问题状态机、不碰已有问题。
// - 七天一句（WONDER_GAP_MS），不与梦、夜间抢料。
import { questionKey } from './questions.js'

export const WONDER_GAP_MS = 7 * 24 * 60 * 60 * 1000
export const WONDER_LAST_KEY = 'wonder.last'
export const WONDER_MIN_CHARS = 6
export const WONDER_MAX_CHARS = 40

/** 造提示词：给几行她最近听到/说过的话当引子，只要一句疑问句。 */
export function wonderPrompt({ lines = [] } = {}) {
  const seed = (Array.isArray(lines) ? lines : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .join('\n')
  return `你在自己待着的时候想起来一件事。

${seed ? `刚才你脑子里是这些：\n${seed}\n\n` : ''}只输出一句中文疑问句，问的是世界/东西/道理（比如「猫为什么会在人的腿上睡觉？」「潮水一天涨几次？」），不要问某个人，不要用"你/他/她"，不要解释，不要引号，不要编号。不超过 ${WONDER_MAX_CHARS} 个字。`
}

/** 把模型输出弄成一句干净的问题；不合格返回 null。 */
export function usableWonder(text) {
  let s = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)[0] || ''
  s = s
    .replace(/^[\s\-–—·•*\d.、)）]+/, '')
    .replace(/^[「『“"]+/, '')
    .replace(/[」』”"]+$/, '')
    .trim()
  if (!s) return null
  const q = s.match(/^(.+?[？?])/)
  if (!q) return null
  const one = q[1].trim()
  const n = [...one].length
  if (n < WONDER_MIN_CHARS || n > WONDER_MAX_CHARS) return null
  if (!/[\u4e00-\u9fff]{3,}/.test(one)) return null
  // 问人的问题不叫"好奇世界"，也不该进自学。
  if (/[你他她]/.test(one)) return null
  if (/^(问|答|搜索|请问)[:：]/.test(one)) return null
  return one
}

function lastWonderAt(store) {
  try {
    return Number(store?.modeGet?.(WONDER_LAST_KEY)) || 0
  } catch {
    return 0
  }
}

/**
 * 想起来一句关于世界的问题，落进问题表。
 * @returns {Promise<{ok:boolean, skipped?:boolean, question?:string, reason?:string}>}
 */
export async function wonder({ store, model, now = Date.now(), gapMs = WONDER_GAP_MS, lines = [], log = () => {} } = {}) {
  if (!store || typeof store.questionPut !== 'function') return { ok: false, reason: '库不支持问题' }
  if (!model || typeof model.ask !== 'function') return { ok: false, reason: '没有模型' }
  const last = lastWonderAt(store)
  if (last && now - last < Math.max(0, Number(gapMs) || 0)) {
    return { ok: false, skipped: true, reason: '还不到时候' }
  }
  let raw = ''
  try {
    raw = String(await model.ask(wonderPrompt({ lines }), { maxTokens: 120 }))
  } catch (e) {
    return { ok: false, reason: `模型没答上来：${e?.message || e}` }
  }
  const text = usableWonder(raw)
  if (!text) {
    log?.('想起来的那句不像问题，丢掉')
    return { ok: false, reason: '没想出能问的问题' }
  }
  const key = questionKey(text)
  if (!key) return { ok: false, reason: '问题算不出 key' }
  try {
    store.questionPut([{ key, kind: 'about', text, refs: [], since: now, status: 'open', source: 'wonder' }])
    store.modeSet?.(WONDER_LAST_KEY, String(now))
  } catch (e) {
    return { ok: false, reason: `存不下：${e?.message || e}` }
  }
  return { ok: true, question: text, key }
}
