// 三本库：events.db（经历，只能追加）、index.db（可重建的索引）、world.db（常识）。
// 每本都先试 sqlite，不可用时退回内存/文件；表结构与旧实现保持一字不差，旧库可以直接接。
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { ensureDirs } from './paths.js'

export const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      refs TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}',
      confidence REAL,
      source TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`

export const INDEX_DDL = [
  `CREATE TABLE IF NOT EXISTS diary (day TEXT PRIMARY KEY, text TEXT NOT NULL, imported TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS docs (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      type TEXT NOT NULL,
      len INTEGER NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      text TEXT NOT NULL DEFAULT ''
    )`,
  `CREATE TABLE IF NOT EXISTS terms (term TEXT NOT NULL, seq INTEGER NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (term, seq))`,
  `CREATE TABLE IF NOT EXISTS attrib (
      seq INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      label TEXT NOT NULL,
      conf REAL NOT NULL,
      why TEXT NOT NULL DEFAULT '',
      by TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS questions (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      refs TEXT NOT NULL DEFAULT '[]',
      since INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS modes (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS studies (
      key TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      facts TEXT NOT NULL,
      sources TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_terms_seq ON terms(seq)`,
  `CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, since)`,
]

export const WORLD_DDL = [
  `CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT '未分类',
      weight REAL NOT NULL DEFAULT 0.5,
      observed INTEGER NOT NULL DEFAULT 1
    )`,
  `CREATE TABLE IF NOT EXISTS objects (name TEXT PRIMARY KEY, elements TEXT NOT NULL DEFAULT '[]', note TEXT)`,
  `CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      thread TEXT,
      text TEXT NOT NULL,
      counterfactual TEXT,
      hypothesis TEXT,
      status TEXT NOT NULL DEFAULT 'untested',
      at INTEGER NOT NULL
    )`,
  `CREATE TABLE IF NOT EXISTS unsettled (
      id TEXT PRIMARY KEY,
      what TEXT NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    )`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`,
]

export const mapEventRow = (r) => ({
  seq: Number(r.seq),
  id: String(r.id),
  ts: Number(r.ts),
  day: String(r.day),
  type: String(r.type),
  text: String(r.text),
  // sqlite 存的是 JSON 字符串，jsonl 存的是已经解析好的数组/对象：两边都认。
  refs: typeof r.refs === 'string' ? safeJson(r.refs, []) : Array.isArray(r.refs) ? r.refs : [],
  meta: typeof r.meta === 'string' ? safeJson(r.meta, {}) : r.meta && typeof r.meta === 'object' ? r.meta : {},
  confidence: r.confidence == null ? null : Number(r.confidence),
  source: String(r.source),
  prev_hash: String(r.prev_hash),
  hash: String(r.hash),
})

export function safeJson(text, fallback) {
  try { return JSON.parse(text) } catch { return fallback }
}

async function trySqlite(file, ddl, label, log) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA synchronous=NORMAL')
    for (const s of ddl) db.exec(s)
    try {
      if (!db.prepare('SELECT COUNT(*) c FROM schema_version').get().c) {
        db.prepare('INSERT INTO schema_version (v) VALUES (1)').run()
      }
    } catch {}
    return { db, backend: 'sqlite', label }
  } catch (e) {
    log?.(`${label}：sqlite 不可用，降级（${e?.message || e}）`)
    return null
  }
}

/** events.db：sqlite 或 events.jsonl。 */
export async function openEventsDb({ root, forceJsonl = false, log = () => {} } = {}) {
  const p = ensureDirs(root)
  if (!forceJsonl) {
    const got = await trySqlite(p.events, [EVENTS_DDL], 'events', log)
    if (got) {
      const { db } = got
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_day ON events(day, ts)')
      let closed = false
      const selectById = db.prepare('SELECT * FROM events WHERE id = ?')
      return {
        backend: 'sqlite',
        db,
        isOpen: () => !closed,
        insert(row) {
          db.prepare(
            'INSERT INTO events (id,ts,day,type,text,refs,meta,confidence,source,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            row.id, row.ts, row.day, row.type, row.text,
            JSON.stringify(row.refs ?? []), JSON.stringify(row.meta ?? {}),
            row.confidence ?? null, row.source, row.prev_hash, row.hash,
          )
          return mapEventRow(selectById.get(row.id))
        },
        all() { return db.prepare('SELECT * FROM events ORDER BY seq').all().map(mapEventRow) },
        last() {
          const r = db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 1').get()
          return r ? mapEventRow(r) : null
        },
        count() { return Number(db.prepare('SELECT COUNT(*) c FROM events').get().c) },
        rewriteHashes(rows) {
          db.exec('BEGIN')
          try {
            const st = db.prepare('UPDATE events SET prev_hash = ?, hash = ? WHERE seq = ?')
            for (const r of rows) st.run(r.prev_hash, r.hash, r.seq)
          } finally {
            db.exec('COMMIT')
          }
        },
        close() { if (!closed) { try { db.close() } catch {} closed = true } },
      }
    }
  }

  // JSONL 降级：整份读进内存，写入 append。
  const file = p.eventsJsonl
  let rows = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  }
  let seq = rows.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0)
  let closed = false
  const flush = () => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  return {
    backend: 'jsonl',
    isOpen: () => !closed,
    insert(row) {
      const full = { seq: ++seq, ...row, refs: row.refs ?? [], meta: row.meta ?? {} }
      rows.push(full)
      appendFileSync(file, JSON.stringify(full) + '\n', 'utf8')
      return full
    },
    all() { return rows.map((r) => mapEventRow(r)) },
    last() { return rows.length ? mapEventRow(rows[rows.length - 1]) : null },
    count() { return rows.length },
    rewriteHashes(list) {
      rows = list.map((r) => ({ ...r }))
      flush()
    },
    close() { closed = true },
  }
}

/** index.db：可删可重建。拿不到 sqlite 就返回 null，由 store 退回内存。 */
export async function openIndexDb({ root, log = () => {} } = {}) {
  const p = ensureDirs(root)
  const got = await trySqlite(p.index, INDEX_DDL, 'index', log)
  if (!got) return null
  return { db: got.db, close: () => { try { got.db.close() } catch {} } }
}

/** world.db：常识层。 */
export async function openWorldDb({ root, log = () => {} } = {}) {
  const p = ensureDirs(root)
  const got = await trySqlite(p.world, WORLD_DDL, 'world', log)
  if (!got) return null
  return { db: got.db, close: () => { try { got.db.close() } catch {} } }
}
