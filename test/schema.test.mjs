import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEvent, ALL_TYPES, HER_TYPES, MAX_TEXT, MAX_REFS } from '../lib/schema.js'

test('schema：正常事件通过，类型齐全', () => {
  assert.ok(ALL_TYPES.includes('utterance'))
  assert.ok(ALL_TYPES.includes('card_patch'))
  assert.ok(ALL_TYPES.includes('grant'))
  assert.ok(HER_TYPES.includes('refusal'))
  assert.deepEqual(validateEvent({ type: 'utterance', text: '嗯。', source: 'tool' }), { ok: true, problems: [] })
  // attach 自动落库的回复用 source:'agent'（以前漏在白名单外，写库被静默拒掉）。
  assert.deepEqual(validateEvent({ type: 'utterance', text: '嗯。', source: 'agent' }), { ok: true, problems: [] })
})

test('schema：未知类型 / 空正文 / 超长 / refs 越界 / 坏 source 都拒绝', () => {
  const bad = validateEvent({ type: 'nope', text: 'x', source: 'tool' })
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join('；'), /未知类型/)

  assert.match(validateEvent({ type: 'meta', text: '   ', source: 'system' }).problems.join('；'), /正文不能为空/)
  assert.match(validateEvent({ type: 'meta', text: 'x'.repeat(MAX_TEXT + 1), source: 'system' }).problems.join('；'), /太长/)
  assert.match(
    validateEvent({ type: 'meta', text: 'x', source: 'system', refs: Array.from({ length: MAX_REFS + 1 }, (_, i) => `ev_${i}`) }).problems.join('；'),
    /refs 太多/,
  )
  assert.match(validateEvent({ type: 'meta', text: 'x', source: 'nobody' }).problems.join('；'), /未知 source/)
})
