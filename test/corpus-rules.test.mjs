// 语料改写候选标记：长+结构、短+盖章、总结收尾。
import test from 'node:test'
import assert from 'node:assert/strict'
import { flagSentence, flagCorpus } from '../lib/corpus-rules.js'

test('corpus-rules：短句+盖章', () => {
  assert.deepEqual(flagSentence('我记下了。'), ['短句+盖章'])
  assert.deepEqual(flagSentence('好。'), ['短句+盖章'])
})

test('corpus-rules：摆两面 / 步骤腔 / 总结收尾', () => {
  assert.ok(flagSentence('这件事不是不能做，而是要先想清楚代价。').includes('摆两面'))
  assert.ok(flagSentence('先把他说的那句话拆开，再看他当时在做什么。').includes('步骤腔'))
  assert.ok(flagSentence('这是边界问题。').includes('总结收尾'))
})

test('corpus-rules：正常短句不标', () => {
  assert.deepEqual(flagSentence('今天有点累，不太想说话。'), [])
})

test('corpus-rules：flagCorpus 计数与上限', () => {
  const r = flagCorpus(['我记下了。', '今天有点累。', '这是两件事。', ''])
  assert.equal(r.total, 2)
  assert.equal(r.counts['短句+盖章'], 1)
  assert.equal(r.counts['总结收尾'], 1)
  assert.equal(r.examples.length, 2)
})
