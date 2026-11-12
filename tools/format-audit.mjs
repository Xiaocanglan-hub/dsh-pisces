#!/usr/bin/env node
// 格式审计 CLI：喂文件，出分项计数 + total。只读，不改文件。
// 用法：node tools/format-audit.mjs <file...> [--json]
import { readFileSync } from 'node:fs'
import { auditFormat } from '../lib/format.js'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const files = argv.filter((a) => a !== '--json')

if (!files.length) {
  console.error('用法: node tools/format-audit.mjs <file...> [--json]')
  process.exit(2)
}

const sum = { headings: 0, numbered: 0, bullets: 0, bold: 0, tables: 0, fences: 0, total: 0 }
const rows = []

for (const file of files) {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    console.error(`读不了 ${file}: ${err.message}`)
    process.exitCode = 1
    continue
  }
  const r = auditFormat(text)
  rows.push({ file, ...r })
  for (const k of Object.keys(sum)) sum[k] += r[k]
}

if (json) {
  console.log(JSON.stringify(rows.length > 1 ? { files: rows, sum } : rows[0], null, 2))
} else {
  for (const r of rows) {
    console.log(
      `${r.file}\t标题 ${r.headings} / 编号 ${r.numbered} / 粗体 ${r.bold}` +
        ` / 列表 ${r.bullets} / 表格 ${r.tables} / 围栏 ${r.fences} / total ${r.total}`,
    )
  }
  if (rows.length > 1) {
    console.log(
      `合计\t标题 ${sum.headings} / 编号 ${sum.numbered} / 粗体 ${sum.bold}` +
        ` / 列表 ${sum.bullets} / 表格 ${sum.tables} / 围栏 ${sum.fences} / total ${sum.total}`,
    )
  }
}
