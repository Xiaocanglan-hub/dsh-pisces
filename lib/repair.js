// 修复窗口：把最近几条 heard/utterance 折成"给检索的加权信号"。
// 纯函数、0 模型调用。只影响检索排序；不改台词、不进 system、不落库。
//
// 为什么在检索侧：n198 定的 P0 是「他纠正/补充/半句时先接住」。
// mode 第二句那条出口已被 n148/n149 判死（提示词层加规则无效），所以这一版只做代码出口：
// 窗口交给 search.js 的 boostRef（末分 ×1.2），per-turn 的系统句等 A/B 过再说。
//
// 两个导出：
// - classifyRepair：判他这句是不是在纠正/追问（Schegloff 修复序列）——只给 need/confidence/targetRef。
// - buildRepairWindow：最近 N 条 heard/utterance → {seqs, tokens, weight, need, confidence, targetRef}。
// 不传 boostRef / 空窗口时，search.js 的打分与改动前逐条一致（见 test/repair.test.mjs 的 golden 用例）。
import { tokenize, REPAIR_BOOST } from './search.js'

// 窗口大小：最近 N 条 heard/utterance。
export const REPAIR_WINDOW = 3

const WINDOW_TYPES = new Set(['heard', 'utterance'])

// 强势纠正：即使开头是「不是啦」这种语气词，后面出现这些也算修复。
const STRONG_CUE = /(我是说|我说的是|你听错|听错|搞错|更正|说错了)/
// 弱势否定：单说「不是」经常只是语气词，要和上一句有重叠才当真。
const WEAK_CUE = /(不是|不是这个|不是那个)/
// 「哈哈」「……」这类别当真：与上一句没有实际词重叠时直接判 none。
const SUPPRESS = /^(哈哈|嘿嘿|呵呵|嗯|哦|唉|啊这|没有啦|不是啦|……|\.\.\.)/
// 带否定的修正：「不是我说的」vs「是我说的」。
const NEGATION = /(不|没|别)/
// 追问碎片：短句 + 问号 + 疑问词（「哪个？」「你说的哪条？」）。
// 普通问句（「他回来了吗」）没有疑问词，不触发。
const WH_WORDS = /(哪个|哪一个|哪条|哪句|谁|什么|啥|哪儿|哪里)/

const round2 = (n) => Math.round(n * 100) / 100

/**
 * 判他这句是不是在纠正/补充/追问。
 * @param {{heard?:string,lastUtterance?:string}} [input]
 * @returns {{need:'none'|'clarify'|'correct', targetRef:string[], confidence:number}}
 */
export function classifyRepair({ heard = '', lastUtterance = '' } = {}) {
  const h = String(heard ?? '').trim()
  const u = String(lastUtterance ?? '').trim()
  if (!h) return { need: 'none', targetRef: [], confidence: 0 }

  const ht = tokenize(h)
  const uset = new Set(tokenize(u))
  const shared = [...new Set(ht.filter((t) => uset.has(t)))]
  const suppressed = SUPPRESS.test(h)
  const strong = STRONG_CUE.test(h)
  const cue = strong || WEAK_CUE.test(h)
  const shortWh = h.length <= 10 && /[?？]/.test(h) && WH_WORDS.test(h)
  const opposite = Boolean(u) && NEGATION.test(h) !== NEGATION.test(u) && shared.length >= 1
  const overlap2 = shared.length >= 2

  let need = 'none'
  let confidence = 0
  if (cue) {
    need = 'correct'
    confidence = strong ? 0.75 : 0.7
  } else if (shortWh) {
    need = 'clarify'
    confidence = 0.5
  } else if (opposite) {
    need = 'correct'
    confidence = 0.55
  } else if (overlap2) {
    need = 'clarify'
    confidence = 0.5
  }

  // 「不是啦今天好累」「哈哈」：不是修复。压分；与上一句一点重叠都没有就直接不算。
  // 强势纠正（「不是啦，我是说那家店」）不压。
  if (suppressed && !strong) {
    confidence = Math.max(0, confidence - 0.3)
    if (!shared.length) {
      need = 'none'
      confidence = 0
    }
  }

  return {
    need,
    targetRef: need === 'none' ? [] : (shared.length ? shared : ht.slice(0, 8)),
    confidence: round2(confidence),
  }
}

/**
 * 窗口里她最后说的那句（classifyRepair 的 lastUtterance）；没有返回空串。
 * 只扫最近 N 条 heard/utterance，与 buildRepairWindow 的取法同一口径。
 */
export function lastUtteranceOf(events = [], limit = REPAIR_WINDOW) {
  const list = Array.isArray(events) ? events : []
  const n = Math.max(1, Number(limit) || REPAIR_WINDOW)
  let seen = 0
  for (let i = list.length - 1; i >= 0 && seen < n; i--) {
    const ev = list[i]
    if (!ev || !ev.text) continue
    const type = String(ev.type ?? '')
    if (!WINDOW_TYPES.has(type)) continue
    seen++
    if (type === 'utterance') return String(ev.text)
  }
  return ''
}

/**
 * 最近 N 条 heard/utterance → 检索加权信号。
 * @param {{events?:Array, heard?:string, lastUtterance?:string, limit?:number}} [input]
 * @returns {{seqs:Set<number>, tokens:Set<string>, weight:number, need:string, confidence:number, targetRef:string[]}}
 *   窗口为空时 seqs/tokens 都是空 Set（search 侧等于不传，结果与改动前一致）。
 */
export function buildRepairWindow({ events = [], heard = '', lastUtterance = '', limit = REPAIR_WINDOW } = {}) {
  const list = Array.isArray(events) ? events : []
  const n = Math.max(1, Number(limit) || REPAIR_WINDOW)
  const picked = []
  for (let i = list.length - 1; i >= 0 && picked.length < n; i--) {
    const ev = list[i]
    if (!ev || !ev.text) continue
    if (!WINDOW_TYPES.has(String(ev.type ?? ''))) continue
    picked.push(ev)
  }

  const lastU = String(lastUtterance ?? '')
    || String(picked.find((e) => String(e.type) === 'utterance')?.text ?? '')
  const cls = classifyRepair({ heard, lastUtterance: lastU })

  const seqs = new Set()
  const tokens = new Set()
  for (const ev of picked) {
    const seq = Number(ev.seq)
    if (Number.isFinite(seq) && seq > 0) seqs.add(seq)
    for (const t of tokenize(String(ev.text ?? ''))) tokens.add(t)
  }
  // 窗口为空：不把 query 自己的词塞进来，保证「没有窗口 = 不改变排序」。
  if (picked.length && cls.targetRef.length) {
    for (const t of cls.targetRef) tokens.add(t)
  }

  return {
    seqs,
    tokens,
    weight: REPAIR_BOOST,
    need: picked.length ? cls.need : 'none',
    confidence: picked.length ? cls.confidence : 0,
    targetRef: picked.length ? cls.targetRef : [],
  }
}
