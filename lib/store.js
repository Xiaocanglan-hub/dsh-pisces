// 事件流：唯一可信源，只能追加。每次写入都接在上一条的 hash 后面，链断了能发现。
// 记法（重建后定的，和老库不同）：hash = sha256(prev_hash + "\n" + JSON.stringify(payload))，
// payload 的键顺序固定为 id, ts, day, type, text, refs, meta, confidence, source。
// 老库第一次被本版打开时，会按新记法重算一遍链并把 algo 记进 meta（见 rechain）。
import { newEventId, dayOf, sha256 } from './util.js'
import { paths } from './paths.js'
import { validateEvent } from './schema.js'
import { openEventsDb, openIndexDb, openWorldDb, safeJson } from './db.js'

export const ZERO_HASH = '0'.repeat(64)
export const ALGO_ID = 'v1:sha256(prev\\njson)'

export function payloadOf(ev) {
  return {
    id: String(ev.id),
    ts: Number(ev.ts),
    day: String(ev.day),
    type: String(ev.type),
    text: String(ev.text),
    refs: ev.refs ?? [],
    meta: ev.meta ?? {},
    confidence: ev.confidence == null ? null : Number(ev.confidence),
    source: String(ev.source),
  }
}

export const hashOf = (prev, payload) => sha256(`${prev}\n${JSON.stringify(payload)}`)

export async function createStore({ root, forceJsonl = false, log = () => {} } = {}) {
  const p = paths(root)
  const events = await openEventsDb({ root, forceJsonl, log })
  const index = await openIndexDb({ root, log })
  const world = await openWorldDb({ root, log })
  let closed = false
  const diaryMem = new Map()

  const eventsDb = () => events.db ?? null
  function metaGet(k) {
    try {
      const r = eventsDb()?.prepare('SELECT v FROM meta WHERE k = ?').get(k)
      return r ? r.v : null
    } catch {
      return null
    }
  }
  function metaSet(k, v) {
    try {
      eventsDb()?.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(k, String(v))
    } catch {}
  }

  function verify() {
    let prev = ZERO_HASH
    let n = 0
    for (const e of events.all()) {
      n += 1
      if (e.prev_hash !== prev) return { ok: false, reason: 'prev_hash 断了', count: n, at: e.id }
      const payload = payloadOf(e)
      if (e.hash !== hashOf(prev, payload)) return { ok: false, reason: 'hash 对不上', count: n, at: e.id }
      prev = e.hash
    }
    return { ok: true, count: n, last: prev }
  }

  function rechain() {
    const rows = events.all()
    let prev = ZERO_HASH
    const out = []
    for (const e of rows) {
      const hash = hashOf(prev, payloadOf(e))
      out.push({ ...e, prev_hash: prev, hash })
      prev = hash
    }
    events.rewriteHashes(out)
    return out.length
  }

  // 老库（sqlite 且没有新记法标记）打开时重算一次；之后靠标记跳过，jsonl 不在打开时重算。
  try {
    if (events.backend === 'sqlite') {
      if (events.count() > 0 && metaGet('hash_algo') !== ALGO_ID) {
        const n = rechain()
        log?.(`事件链按新记法重算：${n} 条（只做一次）`)
      }
      metaSet('hash_algo', ALGO_ID)
    }
  } catch (e) {
    log?.('重算事件链失败：', e?.message || e)
  }

  async function append(input = {}) {
    if (closed) throw new Error('库已关闭')
    const v = validateEvent(input)
    if (!v.ok) throw new Error(`事件不合法：${v.problems.join('；')}`)
    const ts = Number(input.ts) || Date.now()
    const ev = {
      id: String(input.id || newEventId(ts)),
      ts,
      day: String(input.day || dayOf(ts)),
      type: String(input.type),
      text: String(input.text),
      refs: Array.isArray(input.refs) ? input.refs : [],
      meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
      confidence: input.confidence == null ? null : Number(input.confidence),
      source: String(input.source || 'system'),
    }
    const last = events.last()
    const prev = last?.hash || ZERO_HASH
    const row = { ...ev, prev_hash: prev, hash: hashOf(prev, payloadOf(ev)) }
    return events.insert(row)
  }

  // ---- 日记：index.db 里一张表；sqlite 不可用时退回内存 + diary/<day>.md ----
  function diaryPut(rows = []) {
    const list = rows.filter((r) => r && r.day != null && String(r.day).length)
    if (!list.length) return 0
    if (index?.db) {
      const st = index.db.prepare('INSERT OR REPLACE INTO diary (day, text, imported, at) VALUES (?,?,?,?)')
      index.db.exec('BEGIN')
      try {
        for (const r of list) st.run(String(r.day), String(r.text ?? ''), String(r.imported ?? ''), Number(r.at) || Date.now())
      } finally {
        index.db.exec('COMMIT')
      }
      return list.length
    }
    for (const r of list) diaryMem.set(String(r.day), { day: String(r.day), text: String(r.text ?? ''), imported: String(r.imported ?? ''), at: Number(r.at) || Date.now() })
    return list.length
  }

  function diaryAll() {
    if (index?.db) {
      return index.db.prepare('SELECT day, text, imported, at FROM diary ORDER BY day').all().map((r) => ({ ...r }))
    }
    return [...diaryMem.values()]
  }

  // ---- 归因：index.db 的 attrib 表（可丢可重建，不进事件流） ----
  const attribRows = []
  function attribPut(rows = []) {
    if (!rows.length) return 0
    if (index?.db) {
      const st = index.db.prepare('INSERT OR REPLACE INTO attrib (seq,day,label,conf,why,by,model,at) VALUES (?,?,?,?,?,?,?,?)')
      index.db.exec('BEGIN')
      try {
        for (const r of rows) st.run(Number(r.seq), String(r.day), String(r.label), Number(r.conf) || 0.5, String(r.why || ''), String(r.by || 'rule'), String(r.model || ''), Number(r.at) || Date.now())
      } finally {
        index.db.exec('COMMIT')
      }
      return rows.length
    }
    for (const r of rows) {
      const i = attribRows.findIndex((x) => Number(x.seq) === Number(r.seq))
      if (i >= 0) attribRows[i] = { ...r }
      else attribRows.push({ ...r })
    }
    return rows.length
  }
  function attribAll() {
    if (index?.db) return index.db.prepare('SELECT seq,day,label,conf,why,by,model,at FROM attrib ORDER BY seq').all().map((r) => ({ ...r }))
    return attribRows.slice()
  }

  // ---- 悬着的问题：index.db 的 questions 表（可丢可重建；状态以库里为准） ----
  const questionMem = new Map()
  const qRefs = (v) => {
    if (Array.isArray(v)) return v.map(String)
    const j = safeJson(String(v ?? '[]'), [])
    return Array.isArray(j) ? j.map(String) : []
  }
  function questionAll() {
    if (index?.db) {
      return index.db
        .prepare('SELECT key,kind,text,refs,since,status,source,at FROM questions ORDER BY since, key')
        .all()
        .map((r) => ({ ...r, refs: qRefs(r.refs) }))
    }
    return [...questionMem.values()]
      .map((q) => ({ ...q, refs: [...q.refs] }))
      .sort((a, b) => Number(a.since) - Number(b.since) || String(a.key).localeCompare(String(b.key)))
  }
  function questionPut(rows = []) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key)
    if (!list.length) return 0
    if (index?.db) {
      const db = index.db
      const sel = db.prepare('SELECT status, since, refs, text FROM questions WHERE key = ?')
      const ins = db.prepare('INSERT OR REPLACE INTO questions (key,kind,text,refs,since,status,source,at) VALUES (?,?,?,?,?,?,?,?)')
      db.exec('BEGIN')
      try {
        for (const r of list) {
          const key = String(r.key)
          const cur = sel.get(key)
          const refs = qRefs(cur ? cur.refs : [])
          for (const x of qRefs(r.refs)) if (!refs.includes(x)) refs.push(x)
          // 关键：已有行的状态永远不被覆盖（答过的不会因为重扫变回 open）。
          const status = cur ? String(cur.status) : String(r.status || 'open')
          const since = cur ? Math.min(Number(cur.since), Number(r.since) || Number(cur.since)) : Number(r.since) || Date.now()
          const text = cur ? String(cur.text) : String(r.text ?? '')
          ins.run(key, String(r.kind || 'about'), text, JSON.stringify(refs), since, status, String(r.source || ''), Number(r.at) || Date.now())
        }
      } finally {
        db.exec('COMMIT')
      }
      return list.length
    }
    for (const r of list) {
      const key = String(r.key)
      const cur = questionMem.get(key)
      const refs = cur ? [...cur.refs] : []
      for (const x of qRefs(r.refs)) if (!refs.includes(x)) refs.push(x)
      questionMem.set(key, {
        key,
        kind: String(cur?.kind || r.kind || 'about'),
        text: String(cur?.text || r.text || ''),
        refs,
        since: cur ? Math.min(Number(cur.since), Number(r.since) || Number(cur.since)) : Number(r.since) || Date.now(),
        status: String(cur?.status || r.status || 'open'),
        source: String(cur?.source || r.source || ''),
        at: Number(r.at) || Date.now(),
      })
    }
    return list.length
  }
  function questionSetStatus(key, status) {
    const k = String(key)
    if (index?.db) {
      const r = index.db.prepare('UPDATE questions SET status = ?, at = ? WHERE key = ?').run(String(status), Date.now(), k)
      return Number(r?.changes) > 0
    }
    const cur = questionMem.get(k)
    if (!cur) return false
    questionMem.set(k, { ...cur, status: String(status), at: Date.now() })
    return true
  }

  // ---- 自学：index.db 的 studies 表（查来的素材；同一个 key 只留最近一次） ----
  // 表里 facts/sources 是 JSON 字符串；读出去时解成数组，和 questionAll 的 refs 一个口径。
  const studiesMem = new Map()
  const parsedArray = (v) => {
    if (Array.isArray(v)) return v
    const j = safeJson(String(v ?? '[]'), [])
    return Array.isArray(j) ? j : []
  }
  function studiesAll() {
    if (index?.db) {
      return index.db
        .prepare('SELECT key,question,facts,sources,at FROM studies ORDER BY at, key')
        .all()
        .map((r) => ({ ...r, facts: parsedArray(r.facts), sources: parsedArray(r.sources) }))
    }
    return [...studiesMem.values()]
      .map((r) => ({ ...r, facts: [...r.facts], sources: r.sources.map((s) => ({ ...s })) }))
      .sort((a, b) => Number(a.at) - Number(b.at) || String(a.key).localeCompare(String(b.key)))
  }
  function studiesPut(rows = []) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.key)
    if (!list.length) return 0
    if (index?.db) {
      const st = index.db.prepare('INSERT OR REPLACE INTO studies (key,question,facts,sources,at) VALUES (?,?,?,?,?)')
      index.db.exec('BEGIN')
      try {
        for (const r of list) {
          st.run(
            String(r.key),
            String(r.question ?? ''),
            JSON.stringify(Array.isArray(r.facts) ? r.facts.map(String) : []),
            JSON.stringify(Array.isArray(r.sources) ? r.sources : []),
            Number(r.at) || Date.now(),
          )
        }
      } finally {
        index.db.exec('COMMIT')
      }
      return list.length
    }
    for (const r of list) {
      studiesMem.set(String(r.key), {
        key: String(r.key),
        question: String(r.question ?? ''),
        facts: Array.isArray(r.facts) ? r.facts.map(String) : [],
        sources: Array.isArray(r.sources) ? r.sources.map((s) => ({ ...s })) : [],
        at: Number(r.at) || Date.now(),
      })
    }
    return list.length
  }

  // ---- 小状态（分流的主导/band/冷却）放 index.db 的 modes 表：可重建，不是历史 ----
  const modeMem = new Map()
  function modeGet(k) {
    try {
      if (index?.db) {
        const r = index.db.prepare('SELECT v FROM modes WHERE k = ?').get(k)
        return r ? r.v : null
      }
    } catch {}
    return modeMem.has(k) ? modeMem.get(k) : null
  }
  function modeSet(k, v) {
    try {
      if (index?.db) {
        index.db.prepare('INSERT OR REPLACE INTO modes (k, v) VALUES (?, ?)').run(k, String(v))
        return true
      }
    } catch {}
    modeMem.set(k, String(v))
    return true
  }

  // ---- 检索索引：docs / terms 两张表，可删可重建 ----
  const docsMem = new Map()
  const termsMem = new Map()
  function indexClear() {
    if (index?.db) {
      index.db.exec('DELETE FROM docs')
      index.db.exec('DELETE FROM terms')
      return true
    }
    docsMem.clear()
    termsMem.clear()
    return true
  }
  function indexPut({ docs = [], terms = [] } = {}) {
    if (index?.db) {
      const db = index.db
      const d = db.prepare('INSERT OR REPLACE INTO docs (seq,id,ts,day,type,len,importance,text) VALUES (?,?,?,?,?,?,?,?)')
      const t = db.prepare('INSERT OR REPLACE INTO terms (term,seq,tf) VALUES (?,?,?)')
      db.exec('BEGIN')
      try {
        for (const r of docs) d.run(Number(r.seq), String(r.id), Number(r.ts), String(r.day), String(r.type), Number(r.len ?? String(r.text || '').length), Number(r.importance ?? 0.5), String(r.text || ''))
        for (const r of terms) t.run(String(r.term), Number(r.seq), Number(r.tf) || 1)
      } finally {
        db.exec('COMMIT')
      }
      return { docs: docs.length, terms: terms.length }
    }
    for (const r of docs) docsMem.set(Number(r.seq), { ...r })
    for (const r of terms) {
      const k = String(r.term)
      if (!termsMem.has(k)) termsMem.set(k, new Map())
      termsMem.get(k).set(Number(r.seq), Number(r.tf) || 1)
    }
    return { docs: docs.length, terms: terms.length }
  }
  function indexStats() {
    if (index?.db) {
      return {
        docs: Number(index.db.prepare('SELECT COUNT(*) c FROM docs').get().c),
        terms: Number(index.db.prepare('SELECT COUNT(*) c FROM terms').get().c),
      }
    }
    return { docs: docsMem.size, terms: termsMem.size }
  }
  function indexRows(term) {
    if (index?.db) {
      return index.db.prepare('SELECT term, seq, tf FROM terms WHERE term = ?').all(String(term)).map((r) => ({ ...r }))
    }
    return [...(termsMem.get(String(term)) || new Map()).entries()].map(([seq, tf]) => ({ term: String(term), seq, tf }))
  }
  function docBySeq(seq) {
    if (index?.db) {
      const r = index.db.prepare('SELECT * FROM docs WHERE seq = ?').get(Number(seq))
      return r ? { ...r } : null
    }
    return docsMem.get(Number(seq)) || null
  }

  // ---- 常识层：world.db ----
  function worldWrite({ elements = [], objects = [], scenes = [], unsettled = [] } = {}) {
    if (!world?.db) return { ok: false, reason: 'world 不可用' }
    const db = world.db
    const el = db.prepare('INSERT OR REPLACE INTO elements (id,name,kind,weight,observed) VALUES (?,?,?,?,?)')
    const ob = db.prepare('INSERT OR REPLACE INTO objects (name,elements,note) VALUES (?,?,?)')
    db.exec('BEGIN')
    try {
      for (const e of elements) el.run(String(e.id || e.name), String(e.name), String(e.kind || '未分类'), Number(e.weight ?? 0.5), Number(e.observed ?? 1))
      for (const o of objects) ob.run(String(o.name), JSON.stringify(o.elements || []), o.note ?? null)
    } finally {
      db.exec('COMMIT')
    }
    return { ok: true, elements: elements.length, objects: objects.length }
  }

  function worldRead() {
    if (!world?.db) return { elements: [], objects: [], scenes: [], unsettled: [] }
    const db = world.db
    const j = (t, f) => { try { return JSON.parse(t) } catch { return f } }
    return {
      elements: db.prepare('SELECT * FROM elements').all().map((r) => ({ ...r })),
      objects: db.prepare('SELECT * FROM objects').all().map((r) => ({ ...r, elements: j(r.elements, []) })),
      scenes: db.prepare('SELECT * FROM scenes').all().map((r) => ({ ...r })),
      unsettled: db.prepare('SELECT * FROM unsettled').all().map((r) => ({ ...r })),
    }
  }

  return {
    root: p.root,
    backend: events.backend,
    isOpen: () => !closed && events.isOpen(),
    append,
    readAll: () => events.all(),
    count: () => events.count(),
    last: () => events.last(),
    verify,
    rechain,
    metaGet,
    metaSet,
    diaryPut,
    diaryAll,
    attribPut,
    attribAll,
    questionAll,
    questionPut,
    questionSetStatus,
    studiesAll,
    studiesPut,
    modeGet,
    modeSet,
    indexClear,
    indexPut,
    indexStats,
    indexRows,
    docBySeq,
    worldWrite,
    worldRead,
    close() {
      if (closed) return
      closed = true
      try { events.close() } catch {}
      try { index?.close?.() } catch {}
      try { world?.close?.() } catch {}
    },
  }
}
