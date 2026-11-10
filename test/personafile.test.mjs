// 固定段的文件覆盖：`<root>/persona-fixed.md`，写前备份、原子写、坏文件当没有。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  FIXED_BAK,
  FIXED_FILE,
  FIXED_MAX,
  clearFixedOverride,
  fixedBackupPath,
  fixedPath,
  readFixedOverride,
  writeFixedOverride,
} from '../lib/personafile.js'

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-personafile-'))
}

test('personafile：没有文件、空文件、坏文件（目录）都当没有覆盖 → null', () => {
  const root = mkRoot()
  assert.equal(fixedPath(root), path.join(root, FIXED_FILE))
  assert.equal(fixedPath(root).endsWith(`${path.sep}persona-fixed.md`), true)
  assert.equal(readFixedOverride(root), null, '没有文件是 null')

  writeFileSync(fixedPath(root), '\uFEFF  \n\t\n ', 'utf8')
  assert.equal(readFixedOverride(root), null, '只有空白也是 null')

  // 目录占住这个文件名：读会 EISDIR，不抛、当没有覆盖。
  const root2 = mkRoot()
  mkdirSync(fixedPath(root2))
  assert.equal(readFixedOverride(root2), null)

  assert.equal(readFixedOverride(''), null)
  assert.equal(readFixedOverride(null), null)
})

test('personafile：写入后原样读回（去 BOM/首尾空白），文件就落在 <root>/persona-fixed.md', () => {
  const root = mkRoot()
  const text = '你是潮水边的一块软玻璃。\n他说话你就亮一下。'
  const w = writeFixedOverride(root, `\uFEFF\n ${text} \r\n`)
  assert.deepEqual(w, { ok: true })
  assert.equal(readFixedOverride(root), text)
  assert.equal(existsSync(fixedPath(root)), true)
  // 磁盘上的正文也是这段（末尾补一个换行，方便人直接编辑）。
  assert.equal(readFileSync(fixedPath(root), 'utf8'), `${text}\n`)

  // 覆盖写：读回的是新的一版，不是拼接。
  const next = '你是安静的。'
  assert.deepEqual(writeFixedOverride(root, next), { ok: true })
  assert.equal(readFixedOverride(root), next)
})

test('personafile：超过 4000 字拒写，原文件不动', () => {
  const root = mkRoot()
  const before = '旧的一段。'
  writeFixedOverride(root, before)

  const tooLong = '字'.repeat(FIXED_MAX + 1)
  const r = writeFixedOverride(root, tooLong)
  assert.equal(r.ok, false)
  assert.equal(typeof r.reason, 'string')
  assert.ok(r.reason.length > 0)
  assert.equal(readFixedOverride(root), before, '被拒时不该动旧文件')

  // 正好 4000 是允许的。
  assert.deepEqual(writeFixedOverride(root, '字'.repeat(FIXED_MAX)), { ok: true })
  assert.equal(readFixedOverride(root), '字'.repeat(FIXED_MAX))
})

test('personafile：空文本（空串/空白）拒写，原因说人话', () => {
  const root = mkRoot()
  for (const text of ['', '   ', '\n\t\r\n', null, undefined]) {
    const r = writeFixedOverride(root, text)
    assert.equal(r.ok, false, `空文本该拒：${JSON.stringify(text)}`)
    assert.equal(r.reason, '没写东西')
  }
  assert.equal(existsSync(fixedPath(root)), false, '被拒时不该建出文件')
})

test('personafile：写第二次前备份前一份到 persona-fixed.bak.md；clear 后读回 null', () => {
  const root = mkRoot()
  writeFixedOverride(root, '第一版。')
  assert.equal(existsSync(fixedBackupPath(root)), false, '第一次写没有旧文件可备份')

  writeFixedOverride(root, '第二版。')
  assert.equal(fixedBackupPath(root), path.join(root, FIXED_BAK))
  assert.equal(readFileSync(fixedBackupPath(root), 'utf8'), '第一版。\n', '备份是覆盖前的那一份')
  assert.equal(readFixedOverride(root), '第二版。')

  // 第三次写：备份换成第二版，但只留一份。
  writeFixedOverride(root, '第三版。')
  assert.equal(readFileSync(fixedBackupPath(root), 'utf8'), '第二版。\n')

  assert.deepEqual(clearFixedOverride(root), { ok: true })
  assert.equal(readFixedOverride(root), null)
  assert.equal(existsSync(fixedPath(root)), false)
  assert.equal(existsSync(fixedBackupPath(root)), true, 'clear 只删覆盖，备份不动')

  // 本来就没有文件：也算清掉了。
  assert.deepEqual(clearFixedOverride(root), { ok: true })
})
