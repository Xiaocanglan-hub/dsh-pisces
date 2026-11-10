import test from 'node:test'
import assert from 'node:assert/strict'
import { attributeByRule, parseLabel, attributePrompt, D_MARK, I_MARK } from '../lib/attrib.js'

test('归因规则：讲条件/因果的判 d，且 why 写清楚命中了什么', () => {
  const r = attributeByRule({ type: 'utterance', text: '如果你现在走，那我以后就不会再等，因为等这件事本身也要有代价。' })
  assert.equal(r.decided, true)
  assert.equal(r.label, 'd')
  assert.ok(r.conf >= 0.7 && r.conf <= 0.95)
  assert.match(r.why, /\+/)
  assert.ok(D_MARK.includes('因为'))
})

test('归因规则：情绪/短句判 i', () => {
  const r = attributeByRule({ type: 'utterance', text: '我就是觉得有点难过。' })
  assert.equal(r.decided, true)
  assert.equal(r.label, 'i')
  assert.ok(I_MARK.includes('觉得'))
})

test('归因规则：短的纯描述判 null；长的没标记是"拿不准"', () => {
  const d = attributeByRule({ text: '今天风大，窗户关了一半。' })
  assert.equal(d.decided, true)
  assert.equal(d.label, 'null')
  assert.equal(d.why, '纯描述')

  const unsure = attributeByRule({ text: '我把那句话记下来了，但没回，后来也没有再提起。' })
  assert.equal(unsure.decided, false)
  assert.match(unsure.why, /拿不准/)
})

test('模型输出：JSON 优先，其次独立的 d/i/null，最后退回 null', () => {
  assert.deepEqual(parseLabel('{"label":"d","why":"讲条件"}'), { label: 'd', why: '讲条件', conf: 0.75 })
  assert.equal(parseLabel('我觉得是 d').label, 'd')
  assert.equal(parseLabel('i').label, 'i')
  assert.equal(parseLabel('算过的').label, 'd')
  assert.equal(parseLabel('嗯……').label, 'null')
})

test('给模型的提示：明确三种口径，且带上原句', () => {
  const p = attributePrompt({ text: '我不想去。' })
  assert.match(p, /d：/)
  assert.match(p, /i：/)
  assert.match(p, /null：/)
  assert.match(p, /我不想去。/)
})
