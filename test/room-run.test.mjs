import test from 'node:test'
import assert from 'node:assert/strict'
import { runRoom } from '../lib/room-run.js'

const user = (content) => [{ role: 'user', content }]

test('room-run：普通一轮妹妹先说，派希丝补一句', async () => {
  const seen = []
  const call = async (system, messages) => {
    seen.push({ system, messages })
    return seen.length === 1 ? '我听着。' : '先坐下。'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我听着。\n【派希丝】先坐下。')
  assert.equal(r.calls, 2)
  assert.equal(r.teaching, null)
  assert.match(seen[0].system, /只回一句/)
  assert.match(seen[1].system, /客厅监测/)
})

test('room-run：监测 NO 时只留妹妹', async () => {
  let n = 0
  const call = async () => {
    n++
    return n === 1 ? '我听着。' : 'NO'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我听着。')
  assert.equal(r.calls, 2)
})

test('room-run：点名谁就只谁开口', async () => {
  let n = 0
  const call = async () => {
    n++
    return n === 1 ? '我在。后面还有。' : '不该到这里'
  }
  const r = await runRoom({ messages: user('派希丝，你说'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【派希丝】我在。')
  assert.equal(r.calls, 1)

  n = 0
  const r2 = await runRoom({ messages: user('妹妹，你来说'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r2.text, '【普通鱼】我在。')
  assert.equal(r2.calls, 1)
})

test('room-run：监测点名妹妹，妹妹再接一句', async () => {
  let n = 0
  const call = async () => {
    n++
    if (n === 1) return '我听着。'
    if (n === 2) return '@普通鱼 你来说。'
    return '我说一句。'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我听着。\n【派希丝】@普通鱼 你来说。')
  assert.equal(r.calls, 3)
})

test('room-run：教学命中时不走普通补句', async () => {
  let n = 0
  const call = async () => { n++; return '不该调用' }
  const r = await runRoom({ messages: user('他问我怎么办，我拿不定'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(n, 0)
  assert.equal(r.calls, 0)
  assert.equal(r.teaching.id, 'judgment-first')
  assert.match(r.text, /先说结论/)
})

test('room-run：只留一句，异常不炸', async () => {
  let n = 0
  const call = async () => {
    n++
    if (n === 1) return '第一句。第二句。'
    return 'NO'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】第一句。')

  const bad = await runRoom({ messages: user('今天有点累'), call: async () => { throw new Error('x') }, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(bad.text, '')
  assert.equal(bad.error, 'x')
})
