// 检索：把事件切成"能翻回去"的样子。
// 中文用二元组（"窗关了" → 窗关/关了），英文/数字按词；索引落在 index.db 的 docs / terms 两张表，
// 删了能重建，所以它不是历史。
import { clip } from './util.js'
// 索引/检索也过一遍宿主噪声清洗：历史脏 heard 不被 recall 翻出来（数据本身不动）。
import { stripHarnessNoise } from './noise.js'

const HER_TYPES = new Set(['utterance', 'refusal', 'revise', 'narration', 'reunion', 'dream', 'dream_sim', 'answer', 'heard', 'voice', 'ask', 'card_patch', 'question'])
const IMPORTANCE = {
  seed: 1,
  utterance: 1,
  refusal: 1,
  revise: 1,
  narration: 1,
  dream_sim: 0.6,
  answer: 0.6,
  heard: 0.5,
  voice: 0.5,
  ask: 0.8,
  card_patch: 0.9,
}

export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  const push = (t) => { if (t && !out.includes(t)) out.push(t) }
  // 英文词、数字整段
  for (const m of s.matchAll(/[a-z0-9_]+/g)) push(m[0])
  // 中文字段：整段 + 二元组（单字也留一个，短查询能用）
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0]
    if (run.length === 1) push(run)
    for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2))
  }
  return out
}

export function indexable(ev) {
  if (!ev || !ev.text) return false
  if (ev.type === 'meta') return false
  // 整条都是宿主注入块（标题生成 / system-reminder）的不进索引。
  if (!stripHarnessNoise(String(ev.text))) return false
  return HER_TYPES.has(ev.type) || Boolean(IMPORTANCE[ev.type])
}

/** 全量重建索引；返回条数。 */
export function rebuildIndex(store, { log = () => {} } = {}) {
  const events = store.readAll()
  const docs = []
  const terms = []
  for (const ev of events) {
    if (!indexable(ev)) continue
    const text = String(ev.text)
    const tf = new Map()
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1)
    docs.push({
      seq: Number(ev.seq),
      id: ev.id,
      ts: Number(ev.ts),
      day: String(ev.day),
      type: String(ev.type),
      len: text.length,
      importance: IMPORTANCE[ev.type] ?? 0.5,
      text,
    })
    for (const [term, n] of tf) terms.push({ term, seq: Number(ev.seq), tf: n })
  }
  store.indexClear()
  store.indexPut({ docs, terms })
  log(`索引重建：${docs.length} 篇、${terms.length} 个词条`)
  return { docs: docs.length, terms: terms.length }
}

/**
 * 把"还没进索引"的事件补进去（2026-11-11 修）。
 *
 * 老逻辑只在索引**空**的时候重建一次，append 从不更新索引——于是重建之后说的话
 * 永远翻不到，"记得久"在检索层就断了（真机：库里 819 条、索引停在 744，牛肉面那条翻不到）。
 * 现在每次检索前对一下 seq：只把新的补进去，不动旧索引。
 * @returns {{docs:number, terms:number, from?:number}}
 */
export function ensureIndex(store) {
  const stats = store.indexStats?.() || { docs: 0, terms: 0 }
  if (stats.docs === 0) return rebuildIndex(store)
  if (typeof store.indexMaxSeq !== 'function') return { docs: 0, terms: 0 }
  const from = Number(store.indexMaxSeq() || 0)
  const events = store.readAll?.() || []
  const docs = []
  const terms = []
  for (const ev of events) {
    if (Number(ev?.seq) <= from) continue
    if (!indexable(ev)) continue
    const text = String(ev.text)
    const tf = new Map()
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1)
    docs.push({
      seq: Number(ev.seq),
      id: ev.id,
      ts: Number(ev.ts),
      day: String(ev.day),
      type: String(ev.type),
      len: text.length,
      importance: IMPORTANCE[ev.type] ?? 0.5,
      text,
    })
    for (const [term, n] of tf) terms.push({ term, seq: Number(ev.seq), tf: n })
  }
  if (docs.length) store.indexPut({ docs, terms })
  return { docs: docs.length, terms: terms.length, from }
}

/**
 * 翻她的过去。
 * @returns {{items:Array<{id,day,type,text,score}>, ms:number, total:number}}
 */
export function search(store, { query = '', k = 8, budget = 800, now = Date.now() } = {}) {
  const t0 = Date.now()
  const terms = tokenize(query)
  if (!terms.length) return { items: [], ms: 0, total: 0 }

  // 先补索引：刚落库的话也要翻得到，否则她永远只记得"上次重建之前"的事。
  try {
    ensureIndex(store)
  } catch {
    /* 补索引失败不挡检索：最多翻不到最新的一条，不能让整个 recall 挂掉 */
  }
  const stats = store.indexStats?.() || { docs: 1, terms: 0, avgLen: 60 }
  const N = Math.max(1, Number(stats.docs) || 1)
  const avgLen = Math.max(1, Number(stats.avgLen) || 60)

  // BM25：tf 饱和 + 按文档长度归一化（2026-11-12）。
  // 老公式是 tf×idf 求和，长文（誊抄整段对话）靠重复命中就能通吃短句，
  // 真机里那条"牛肉面"被一段 800 字的誊抄挤掉。现在长度按全库均值折算。
  const K1 = 1.2
  const B = 0.75
  const docCache = new Map()
  const docOf = (seq) => {
    if (!docCache.has(seq)) docCache.set(seq, store.docBySeq?.(seq) || null)
    return docCache.get(seq)
  }
  const score = new Map()
  for (const term of terms) {
    const rows = store.indexRows?.(term) || []
    const df = rows.length
    if (!df) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const r of rows) {
      const seq = Number(r.seq)
      const doc = docOf(seq)
      if (!doc) continue
      const len = Math.max(1, Number(doc.len ?? 0) || String(doc.text || '').length || 1)
      const tf = Number(r.tf) || 1
      const denom = tf + K1 * (1 - B + (B * len) / avgLen)
      score.set(seq, (score.get(seq) || 0) + idf * ((tf * (K1 + 1)) / denom))
    }
  }

  // 问句回声：他刚问的那句本身会以 heard 落库，再被同一句话检索出来没有意义。
  // 只在 type=heard 上过滤，且要求词集几乎相同（不是"包含"），免得误伤真正相关的旧话。
  const qSet = new Set(terms)
  const isEcho = (doc) => {
    if (String(doc.type) !== 'heard') return false
    const dts = tokenize(String(doc.text ?? ''))
    if (!dts.length) return false
    let inter = 0
    for (const t of dts) if (qSet.has(t)) inter++
    const union = qSet.size + dts.length - inter
    return union > 0 && inter / union >= 0.9
  }

  const items = []
  for (const [seq, s] of score) {
    const doc = docOf(seq)
    if (!doc) continue
    // 旧索引里已经塞进去的注入块（标题生成 / system-reminder）照样跳过：
    // 不重建索引也能挡住，避免 recall 把宿主的话当他的话翻出来。
    if (!stripHarnessNoise(String(doc.text ?? ''))) continue
    if (isEcho(doc)) continue
    const days = Math.max(0, Math.floor((now - Number(doc.ts)) / 86_400_000))
    const recency = Math.exp(-days / 60)
    const v = s * Number(doc.importance ?? 0.5) * (0.7 + 0.3 * recency)
    items.push({ id: doc.id, day: doc.day, type: doc.type, text: clip(doc.text, 240), score: Math.round(v * 1000) / 1000, _len: doc.text.length })
  }
  items.sort((a, b) => b.score - a.score || String(b.day).localeCompare(String(a.day)))

  const picked = []
  let used = 0
  for (const it of items) {
    if (picked.length >= k) break
    // 预算按"实际会进提示词的长度"算：正文只 clip 到 240 字，拿原始长度去占预算，
    // 一条超长的誊抄/长文就能把后面所有记忆挤掉（2026-11-11 真机：整段对话誊抄吃掉 800 字）。
    const cost = Math.min(it._len, 240)
    if (used + cost > budget && picked.length) continue
    picked.push(it)
    used += cost
  }
  return {
    items: picked.map(({ _len, ...rest }) => rest),
    ms: Date.now() - t0,
    total: items.length,
  }
}
