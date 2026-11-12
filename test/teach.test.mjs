// 教人养鱼：九个话题、认不出的话题给总纲，不编。
import test from 'node:test'
import assert from 'node:assert/strict'
import { ADULT_LABEL, ADULT_NAME, GUIDE, guideFor, guideTopics } from '../lib/teach.js'

const TOPICS = ['start', 'days', 'split', 'refuse', 'memory', 'card', 'dream', 'night', 'cheap']

test('teach：九个话题各有一句具体建议，guideFor 原样取到', () => {
  assert.equal(ADULT_NAME, '派希丝')
  assert.equal(ADULT_LABEL, '领养姐姐派希丝')
  for (const topic of TOPICS) {
    assert.equal(typeof GUIDE[topic], 'string', `${topic} 应该有一句建议`)
    assert.ok(GUIDE[topic].trim().length > 0, `${topic} 的建议不能是空话`)
    assert.equal(guideFor(topic), GUIDE[topic])
  }
})

test('teach：认不出的话题回"养鱼没有捷径"总纲 + 可用话题', () => {
  const words = guideFor('没听过的话题')
  assert.match(words, /养鱼没有捷径/)
  for (const topic of TOPICS) assert.ok(words.includes(topic), `总纲里应该提到 ${topic}`)
})

test('teach：guideTopics 长度就是九个', () => {
  const topics = guideTopics()
  assert.equal(topics.length, 9)
  assert.deepEqual([...topics].sort(), [...TOPICS].sort())
})
