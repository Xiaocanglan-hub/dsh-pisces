// 新手引导：十一个话题的正文 + 状态感知的下一步。
// 只验纯函数；不碰库、不碰 ctx。
import test from 'node:test'
import assert from 'node:assert/strict'
import { GUIDE, GUIDE_TOPICS, guideFor, nextStep } from '../lib/guide.js'

const TOPICS = [
  'first-meet',
  'seed',
  'adopt',
  'start-chat',
  'daily',
  'quiet',
  'panel',
  'trouble',
  'backup',
  'privacy',
  'speak',
]

// 设计稿第 5 节：不说术语。这三个词最容易漏进来。
const FORBIDDEN = ['事件流', '归因', '分流']

test('guide：十一个话题，顺序固定', () => {
  assert.deepEqual(GUIDE_TOPICS, TOPICS)
  assert.equal(GUIDE_TOPICS.length, 11)
  assert.deepEqual(Object.keys(GUIDE), TOPICS)
})

test('guide：每篇都有正文，3–6 行，没有空行', () => {
  for (const topic of GUIDE_TOPICS) {
    const body = GUIDE[topic]
    assert.equal(typeof body, 'string', `${topic} 没有正文`)
    assert.ok(body.trim(), `${topic} 是空的`)
    const lines = body.split('\n')
    assert.ok(lines.length >= 3, `${topic} 只有 ${lines.length} 行，太少`)
    assert.ok(lines.length <= 6, `${topic} 有 ${lines.length} 行，太多`)
    assert.ok(lines.every((l) => l.trim()), `${topic} 有空行`)
  }
})

test('guide：不说术语（事件流 / 归因 / 分流）', () => {
  for (const topic of GUIDE_TOPICS) {
    for (const word of FORBIDDEN) {
      assert.equal(GUIDE[topic].includes(word), false, `${topic} 里出现了「${word}」`)
    }
  }
})

test('guide：认得出的话题原样回正文', () => {
  for (const topic of GUIDE_TOPICS) {
    assert.equal(guideFor(topic), GUIDE[topic])
  }
  // 大小写 / 前后空白都归一。
  assert.equal(guideFor('  SEED  '), GUIDE.seed)
})

test('guide：未知话题回「我能讲的有：…」+ 全部话题 + 总纲', () => {
  for (const topic of ['', 'unknown-topic', 'whatever']) {
    const text = guideFor(topic)
    assert.ok(text.startsWith('我能讲的有：'), text)
    for (const name of GUIDE_TOPICS) assert.ok(text.includes(name), `话题表缺 ${name}`)
    assert.ok(text.includes('一次只做一件事'), '要带一句总纲')
  }
})

test('guide：nextStep 拿不到 state → first-meet', () => {
  for (const args of [undefined, {}, { state: null }, { state: 'nope' }]) {
    const step = nextStep(args)
    assert.equal(step.topic, 'first-meet')
    assert.equal(step.text, GUIDE['first-meet'])
    assert.ok(step.why)
  }
})

test('guide：没起点 → seed，并提一句「还能领养」', () => {
  const step = nextStep({ state: { hasSeed: false, events: 0 } })
  assert.equal(step.topic, 'seed')
  assert.equal(step.text, GUIDE.seed)
  assert.match(step.why, /领养/)
})

test('guide：有起点但事件 ≤1 → start-chat', () => {
  for (const events of [0, 1]) {
    const step = nextStep({ state: { hasSeed: true, events, tier: 0 } })
    assert.equal(step.topic, 'start-chat')
    assert.equal(step.text, GUIDE['start-chat'])
  }
})

test('guide：有事件、好感 tier 0/1 → daily', () => {
  for (const tier of [0, 1]) {
    const step = nextStep({ state: { hasSeed: true, events: 5, tier } })
    assert.equal(step.topic, 'daily')
    assert.equal(step.text, GUIDE.daily)
  }
  // 事件数也认数组形状；没有 tier 当 0。
  const step = nextStep({ state: { hasSeed: true, events: [1, 2, 3] } })
  assert.equal(step.topic, 'daily')
})

test('guide：有事件且 tier ≥2 → panel', () => {
  for (const tier of [2, 3]) {
    const step = nextStep({ state: { hasSeed: true, events: 9, tier } })
    assert.equal(step.topic, 'panel')
    assert.equal(step.text, GUIDE.panel)
    assert.ok(step.why)
  }
})
