// 格式审计：只数字面痕迹；代码围栏单列、不计入 total。
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditFormat } from '../lib/format.js'

test('format：正常段落全 0', () => {
  const r = auditFormat('今天风大，窗户关了一半。\n他说晚点回来。')
  assert.deepEqual(r, {
    headings: 0,
    numbered: 0,
    bullets: 0,
    bold: 0,
    tables: 0,
    fences: 0,
    total: 0,
  })
})

test('format：标题 / 编号 / 列表 / 粗体各计 1', () => {
  const r = auditFormat('# 标题\n1. 第一\n- 项目\n**重点**')
  assert.equal(r.headings, 1)
  assert.equal(r.numbered, 1)
  assert.equal(r.bullets, 1)
  assert.equal(r.bold, 1)
  assert.equal(r.total, 4)
})

test('format：代码围栏单列，里面的标题/列表不算', () => {
  const r = auditFormat('```\n# 不是标题\n- 不是列表\n```')
  assert.equal(r.fences, 2)
  assert.equal(r.headings, 0)
  assert.equal(r.bullets, 0)
  assert.equal(r.total, 0)
})

test('format：表格计 1（表头 + 分隔行）', () => {
  const r = auditFormat('| 项 | 值 |\n| --- | --- |\n| a | 1 |')
  assert.equal(r.tables, 1)
  assert.ok(r.total >= 1)
})

test('format：非字符串安全', () => {
  for (const v of [null, undefined, 123, {}, []]) {
    assert.equal(auditFormat(v).total, 0)
  }
})
