import test from 'node:test'
import assert from 'node:assert/strict'
import { stripHarnessNoise } from '../lib/noise.js'

test('noise：同一行的注入块只抠块，保留后面的正文', () => {
  const s = '<system-reminder>知识库大纲：n1 怎么验证…</system-reminder>今天有点累'
  assert.equal(stripHarnessNoise(s), '今天有点累')
})

test('noise：多行注入块，闭合行后面的正文也留着', () => {
  const s = ['开头一句。', '<system-reminder>', '技能目录', '</system-reminder>结尾一句。'].join('\n')
  assert.equal(stripHarnessNoise(s), '开头一句。\n结尾一句。')
})

test('noise：没有闭合标签就当尾部整块删到结尾', () => {
  const s = '他说的那句。\n<system-reminder>\n后面全是注入'
  assert.equal(stripHarnessNoise(s), '他说的那句。')
})

test('noise：available_skills 整块也剥', () => {
  const s = '好。\n<available_skills>\n- foo\n</available_skills>'
  assert.equal(stripHarnessNoise(s), '好。')
})

test('noise：整条都是注入就回空串', () => {
  assert.equal(stripHarnessNoise('<system-reminder>全部是注入</system-reminder>'), '')
  assert.equal(stripHarnessNoise(''), '')
})
