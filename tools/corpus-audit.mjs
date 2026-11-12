#!/usr/bin/env node
// 语料测量 CLI：按 --spec 里的分组读 soul/jsonl/db，输出六个数。
// 只读：db 先复制到临时目录再开只读连接，不碰真实库。
import { readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { measure } from '../lib/corpus.js'
import { stripHarnessNoise } from '../lib/noise.js'

function readSoul(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'))
  return Array.isArray(j) ? j : Array.isArray(j.events) ? j.events : []
}

function readJsonl(file) {
  const raw = readFileSync(file, 'utf8').trim()
  if (!raw) return []
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw)
      return Array.isArray(j) ? j : Array.isArray(j.events) ? j.events : []
    } catch {
      // 落到 JSONL
    }
  }
  return raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

function readDb(file, { source, types }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pisces-corpus-'))
  const base = path.basename(file)
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const src = file + suffix
      if (existsSync(src)) copyFileSync(src, path.join(dir, base + suffix))
    }
    const db = new DatabaseSync(path.join(dir, base), { readOnly: true })
    const ts = types && types.length ? types : ['utterance']
    const where = [`type IN (${ts.map(() => '?').join(',')})`]
    const params = [...ts]
    if (source) {
      where.push('source = ?')
      params.push(source)
    }
    const rows = db.prepare(`SELECT text FROM events WHERE ${where.join(' AND ')} ORDER BY seq`).all(...params)
    db.close()
    return rows.map((r) => String(r.text ?? ''))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function textsOf(events, types) {
  const set = new Set(types && types.length ? types : ['utterance'])
  return events
    .filter((e) => e && set.has(String(e.type)) && typeof e.text === 'string' && e.text.trim())
    .map((e) => e.text)
}

function printTable(rows) {
  const head = ['组', '条', '字', '句', '平均句长', 'CV', '≤6字%', '语气/千', '盖章/千', '结构/千', '窗≥2%', '窗≥3%']
  const body = rows.map((r) => [
    r.label, r.n, r.chars, r.sentences, r.meanLen, r.cv,
    r.shortPct, r.particlePer1k, r.receiptPer1k, r.structurePer1k, r.cluster2Pct, r.cluster3Pct,
  ])
  const all = [head, ...body]
  const widths = head.map((_, i) => Math.max(...all.map((row) => String(row[i]).length)))
  const line = (row) => `| ${row.map((v, i) => String(v).padEnd(widths[i])).join(' | ')} |`
  console.log(line(head))
  console.log(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`)
  for (const row of body) console.log(line(row))
}

const args = process.argv.slice(2)
const specIdx = args.indexOf('--spec')
const specPath = specIdx >= 0 ? args[specIdx + 1] : null
if (!specPath) {
  console.error('用法: node tools/corpus-audit.mjs --spec <groups.json> [--json]')
  process.exit(1)
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const rows = []
for (const g of spec) {
  let texts = []
  if (g.soul) texts = textsOf(readSoul(g.soul), g.types)
  else if (g.db) texts = readDb(g.db, g)
  else if (g.file) texts = textsOf(readJsonl(g.file), g.types)
  else throw new Error(`组 ${g.label || ''} 没有 soul/db/file`)
  if (g.stripNoise) texts = texts.map((t) => stripHarnessNoise(t)).filter(Boolean)
  rows.push({ label: String(g.label || ''), ...measure(texts) })
}

if (args.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  printTable(rows)
}
