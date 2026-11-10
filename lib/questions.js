// 自疑问（M3 上半）：从事件流里捞"还悬着的问题"。
// 三类来源：她问过没人答的（about）、问"你/他"的（to-you）、归因拿不准又查得到的（uncertain）。
// 口径：同一句话的不同说法按 Dice >= 0.8 合并，key 永远用第一句算；
// 已经 answered / dropped / observed 的问题，同步时保留原状态，只补新的。
//
// 第三个来源要读 attrib 表，但 extractQuestions 的入参只有事件流；
// 所以 attrib 行作为可选第二个参数传进来（syncQuestions 从 store.attribAll() 取）。
import { sha256 } from './util.js'

export const QUESTION_STATUS = ['open', 'answered', 'dropped', 'observed']
export const MERGE_DICE = 0.8
export const MIN_UNCERTAIN_CHARS = 8

// 与老库一致的去噪：空白和常见标点都去掉，破折号「——」保留（老 key 里它算正文）。
const NOISE = /[\s\u3000，。？！、；：""''「」『』《》〈〉（）【】\[\]{}…,.;:!?()\-_~·]/g

/** 只留"这句话在说什么"：去空白、去标点。key 和 Dice 都用它。 */
export function normalizeQuestion(text) {
  return String(text ?? '').replace(NOISE, '')
}

/** 问句的 key：sha256(规整后的问句).slice(0, 16)。老库里就是 16 位十六进制。 */
export function questionKey(text) {
  return sha256(normalizeQuestion(text)).slice(0, 16)
}

/**
 * 中文 n-gram 集合：单字 + 二元组。
 * 只用二元组时，"他为什么不解释" vs "他为什么不肯解释" 只有 0.77——只差一个"肯"，
 * 读起来是同一句；补上单字后是 0.86。单字不主导，但不会让一个插入字把整句判成新问题。
 */
function grams(text) {
  const chars = [...normalizeQuestion(text)]
  if (!chars.length) return []
  const out = [...chars]
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
  return out
}

/** 中文 n-gram Dice：0 完全不同，1 完全一样。>= 0.8 视为同一句的不同说法。 */
export function dice(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.length || !B.length) return A.length === B.length ? 1 : 0
  const counts = new Map()
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1)
  let inter = 0
  for (const g of B) {
    const n = counts.get(g) || 0
    if (n > 0) {
      inter += 1
      counts.set(g, n - 1)
    }
  }
  return (2 * inter) / (A.length + B.length)
}

const PURE = /^[啊呀哇哦哎唉哈嘿嗯呃诶噢喔唷啦吧呢吗嘛么]+$/

/** 纯感叹/纯语气词（"啊啊啊？？？"）不是问题，也不值得查。 */
export function isPureExclamation(text) {
  const t = normalizeQuestion(text)
  return !t || PURE.test(t)
}

function hasQuestionMark(text) {
  return /[？?]/.test(String(text ?? ''))
}

/**
 * 同一段里既有"你"也有"他"时按 to-you 算：问的是对方，不是自言自语。
 * 只认这两个字（README 的原话），不做代词消解。
 */
function kindOf(text) {
  return /[你他]/.test(String(text ?? '')) ? 'to-you' : 'about'
}

function refsOf(ev) {
  return Array.isArray(ev?.refs) ? ev.refs : []
}

function hasConcreteSubject(text) {
  const t = normalizeQuestion(text)
  return t.length >= MIN_UNCERTAIN_CHARS && !isPureExclamation(text)
}

/**
 * 她问过、没人答的。两类"答过"都算：
 * 1. 之后有 answer 事件的 refs 指向这条；
 * 2. 同一天里、之后有像回答的句子（answer 或 heard——heard 是他真的回话了）。
 */
function looksAnswered(ev, events, answeredIds) {
  if (!ev?.id || answeredIds.has(String(ev.id))) return true
  const day = String(ev.day ?? '')
  const ts = Number(ev.ts) || 0
  for (const e of events) {
    if (!e || String(e.id) === String(ev.id)) continue
    if (String(e.day ?? '') !== day) continue
    if ((Number(e.ts) || 0) < ts) continue
    if (e.type === 'answer' || e.type === 'heard') return true
  }
  return false
}

function fromUtterance(ev, events, answeredIds) {
  if (ev?.type !== 'utterance') return null
  const text = String(ev.text ?? '').trim()
  if (!text || !hasQuestionMark(text)) return null
  if (isPureExclamation(text)) return null
  if (looksAnswered(ev, events, answeredIds)) return null
  return {
    key: questionKey(text),
    kind: kindOf(text),
    text,
    refs: ev.id ? [String(ev.id)] : [],
    since: Number(ev.ts) || 0,
    source: 'utterance',
  }
}

/**
 * 归因拿不准、但原句里有具体内容的：label='null' 且 conf<0.5，
 * 原句长度 >= 8（去标点后）且不是纯感叹。attrib.seq 指回 events.seq。
 */
function fromAttrib(events, attribs) {
  const bySeq = new Map()
  for (const e of events) if (e && e.seq != null) bySeq.set(Number(e.seq), e)
  const out = []
  for (const a of Array.isArray(attribs) ? attribs : []) {
    if (!a || String(a.label) !== 'null') continue
    if (!(Number(a.conf) < 0.5)) continue
    const ev = bySeq.get(Number(a.seq))
    if (!ev) continue
    const text = String(ev.text ?? '').trim()
    if (!text || !hasConcreteSubject(text)) continue
    out.push({
      key: questionKey(text),
      kind: 'uncertain',
      text,
      refs: ev.id ? [String(ev.id)] : [],
      since: Number(ev.ts) || 0,
      source: 'attrib',
    })
  }
  return out
}

function mergeCandidates(list) {
  const out = []
  for (const c of list) {
    let hit = null
    for (const m of out) {
      if (m.key === c.key || dice(m.text, c.text) >= MERGE_DICE) {
        hit = m
        break
      }
    }
    if (!hit) {
      out.push({ ...c, refs: [...c.refs] })
      continue
    }
    for (const r of c.refs) if (!hit.refs.includes(r)) hit.refs.push(r)
    hit.since = Math.min(hit.since, c.since)
  }
  return out
}

/**
 * 从事件流里捞候选。纯函数：不改入参、不碰库。
 * @param {Array} events 事件流（按 seq/时间先后）
 * @param {Array} attribs attrib 行（可选；不给就只有前两类来源）
 * @returns {Array<{key,kind,text,refs,since,source}>}
 */
export function extractQuestions(events = [], attribs = []) {
  const all = Array.isArray(events) ? events.filter(Boolean) : []
  const answeredIds = new Set()
  for (const e of all) {
    if (e.type !== 'answer') continue
    for (const r of refsOf(e)) answeredIds.add(String(r))
  }

  const found = []
  for (const ev of all) {
    const q = fromUtterance(ev, all, answeredIds)
    if (q) found.push(q)
  }
  found.push(...fromAttrib(all, attribs))

  return mergeCandidates(found).sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
}

function parseRefs(v) {
  if (Array.isArray(v)) return v.map(String)
  try {
    const j = JSON.parse(String(v ?? '[]'))
    return Array.isArray(j) ? j.map(String) : []
  } catch {
    return []
  }
}

function unionRefs(a, b) {
  const out = [...a]
  for (const r of b) if (!out.includes(r)) out.push(r)
  return out
}

/**
 * 扫一遍事件流，把新问题补进 questions 表。已经答过的不改状态、只补新的。
 * @returns {{added:number, merged:number, kept:number, total:number}}
 */
export function syncQuestions(store, { now = Date.now() } = {}) {
  const events = store?.readAll?.() || []
  const attribs = store?.attribAll?.() || []
  const candidates = extractQuestions(events, attribs)
  const current = (store?.questionAll?.() || []).map((q) => ({ ...q, refs: parseRefs(q.refs) }))
  const byKey = new Map(current.map((q) => [String(q.key), q]))

  let added = 0
  let merged = 0
  const rows = []
  const touched = new Set()

  for (const c of candidates) {
    let old = byKey.get(String(c.key))

    // key 对不上时再按 Dice 找一次：同一句的新说法不该长成第二条。
    if (!old) {
      let best = null
      let bestScore = 0
      for (const q of current) {
        const score = dice(q.text, c.text)
        if (score >= MERGE_DICE && score > bestScore) {
          best = q
          bestScore = score
        }
      }
      old = best
    }

    if (!old) {
      const row = {
        key: String(c.key),
        kind: String(c.kind),
        text: String(c.text),
        refs: c.refs.map(String),
        since: Number(c.since) || Number(now),
        status: 'open',
        source: String(c.source),
        at: Number(now) || Date.now(),
      }
      rows.push(row)
      byKey.set(row.key, row)
      touched.add(row.key)
      added += 1
      continue
    }

    const key = String(old.key)
    // 已经 answered / dropped / observed 的：不扫回 open，也不改正文。
    if (String(old.status) !== 'open') {
      continue
    }

    const refs = unionRefs(old.refs, c.refs.map(String))
    const since = Math.min(Number(old.since) || Infinity, Number(c.since) || Infinity)
    const grew = refs.length > old.refs.length || since < Number(old.since)
    if (!grew) {
      continue
    }
    const row = {
      key,
      kind: String(old.kind || c.kind),
      text: String(old.text || c.text),
      refs,
      since: Number.isFinite(since) ? since : Number(old.since) || Number(now),
      status: 'open',
      source: String(old.source || c.source),
      at: Number(now) || Date.now(),
    }
    rows.push(row)
    const idx = current.findIndex((q) => String(q.key) === key)
    if (idx >= 0) current[idx] = row
    byKey.set(key, row)
    touched.add(key)
    merged += 1
  }

  if (rows.length) store?.questionPut?.(rows)

  // kept 是"库里本来就有、这次没动"的全部行：包括已经 closed 的、
  // 以及这次没被扫到的——它们都还在，只是没变化。
  const kept = current.filter((q) => !touched.has(String(q.key))).length

  let total = 0
  try {
    total = (store?.questionAll?.() || []).length
  } catch {
    total = byKey.size
  }
  return { added, merged, kept, total }
}

/**
 * 列问题。默认只出 open，按 since 从旧到新；limit 默认 50。
 * status 传 'all' 或 null 时不过滤。
 */
export function listQuestions(store, { status = 'open', limit = 50 } = {}) {
  const all = (store?.questionAll?.() || []).map((q) => ({ ...q, refs: parseRefs(q.refs) }))
  const rows = status == null || String(status) === 'all' ? all : all.filter((q) => String(q.status) === String(status))
  rows.sort((a, b) => (Number(a.since) || 0) - (Number(b.since) || 0) || String(a.key).localeCompare(String(b.key)))
  const n = Math.max(0, Number(limit))
  return rows.slice(0, Number.isFinite(n) ? n : 50)
}

/** 改状态。只认 QUESTION_STATUS 里的四个词；不合法或 key 不存在都返回人话 reason。 */
export function setQuestionStatus(store, key, status) {
  const want = String(status ?? '')
  if (!QUESTION_STATUS.includes(want)) {
    return { ok: false, reason: `状态只能是 ${QUESTION_STATUS.join(' / ')}` }
  }
  if (!key) return { ok: false, reason: '没有这条问题' }
  if (typeof store?.questionSetStatus !== 'function') return { ok: false, reason: '库不支持改问题状态' }
  const ok = store.questionSetStatus(String(key), want)
  return ok ? { ok: true } : { ok: false, reason: '没有这条问题' }
}
