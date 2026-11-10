// 检索：把事件切成"能翻回去"的样子。
// 中文用二元组（"窗关了" → 窗关/关了），英文/数字按词；索引落在 index.db 的 docs / terms 两张表，
// 删了能重建，所以它不是历史。
import { clip } from './util.js'

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
 * 翻她的过去。
 * @returns {{items:Array<{id,day,type,text,score}>, ms:number, total:number}}
 */
export function search(store, { query = '', k = 8, budget = 800, now = Date.now() } = {}) {
  const t0 = Date.now()
  const terms = tokenize(query)
  if (!terms.length) return { items: [], ms: 0, total: 0 }

  const stats = store.indexStats?.() || { docs: 0, terms: 0 }
  if (stats.docs === 0) rebuildIndex(store)
  const N = Math.max(1, (store.indexStats?.() || { docs: 1 }).docs)

  const score = new Map()
  const df = new Map()
  for (const term of terms) {
    const rows = store.indexRows?.(term) || []
    df.set(term, rows.length)
    for (const r of rows) {
      const prev = score.get(Number(r.seq)) || 0
      score.set(Number(r.seq), prev + (Number(r.tf) || 1) * (1 + Math.log(Math.max(1, N / Math.max(1, rows.length)))))
    }
  }

  const items = []
  for (const [seq, s] of score) {
    const doc = store.docBySeq?.(seq)
    if (!doc) continue
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
    if (used + it._len > budget && picked.length) continue
    picked.push(it)
    used += it._len
  }
  return {
    items: picked.map(({ _len, ...rest }) => rest),
    ms: Date.now() - t0,
    total: items.length,
  }
}
