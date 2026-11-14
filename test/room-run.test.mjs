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
  assert.equal(r.text, '【普通鱼】我听着。\n\n【派希丝】先坐下。')
  assert.equal(r.calls, 2)
  assert.equal(r.teaching, null)
  assert.match(seen[0].system, /只回一句/)
  assert.match(seen[1].system, /客厅监测/)
})

test('room-run：宿主注入块不算他说的话', async () => {
  const seen = []
  const call = async (system, messages) => {
    seen.push(messages)
    return seen.length === 1 ? '我在。' : 'NO'
  }
  const noisy = '<system-reminder>知识库大纲：n1 怎么在真实 DSH 宿主里验证…</system-reminder>今天有点累'
  await runRoom({ messages: user(noisy), call, piscesSystem: 'P', fishSystem: 'F' })
  const lastUser = seen[0].filter((m) => m.role === 'user').at(-1)
  const text = String(lastUser.content[0].text)
  assert.match(text, /今天有点累/)
  assert.doesNotMatch(text, /知识库大纲|system-reminder/)
})

test('room-run：她自己带了名字前缀，也不会叠两层', async () => {
  let n = 0
  const call = async () => {
    n++
    return n === 1 ? '【普通鱼】我听着。' : 'NO'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我听着。')
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

test('room-run：监测点名妹妹，不再额外喊一次（那次子调用是白跑的）', async () => {
  let n = 0
  const call = async () => {
    n++
    if (n === 1) return '我听着。'
    if (n === 2) return '@普通鱼 你来说。'
    return '我说一句。'
  }
  const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我听着。\n\n【派希丝】@普通鱼 你来说。')
  // 2026-11-14：点名后的那次 fish 子调用被删了（回了话却整段丢掉、白付一次调用）。
  assert.equal(r.calls, 2, '只有 fish + monitor 两次')
  assert.equal(n, 2, '第三次调用不该发生')
})

test('room-run：谁先被提到谁先说（先问的在前）', async () => {
  let n = 0
  const call = async () => {
    n++
    return n === 1 ? '我问一句。后面还有。' : '我答一句。别急。'
  }
  const r = await runRoom({ messages: user('派希丝先问，普通鱼回答'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【派希丝】我问一句。\n\n【普通鱼】我答一句。')
})

test('room-run：两个都点名，各回一句', async () => {
  let n = 0
  const call = async () => {
    n++
    return n === 1 ? '我先说。后面还有。' : '我说一句。别急。'
  }
  const r = await runRoom({ messages: user('普通鱼、派希丝，你们说说'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(r.text, '【普通鱼】我先说。\n\n【派希丝】我说一句。')
  assert.equal(r.calls, 2)
})

test('room-run：教学命中时妹妹先答一句，派希丝主动教', async () => {
  let n = 0
  const call = async () => { n++; return '我拿不定。' }
  const r = await runRoom({ messages: user('他问我怎么办，我拿不定'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.equal(n, 1)
  assert.equal(r.calls, 1)
  assert.equal(r.teaching.id, 'judgment-first')
  assert.match(r.text, /【普通鱼】我拿不定。/)
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

test('room-run：把「卡在哪一步」的 kind 交给调用方', async () => {
  const kinds = []
  const call = async (system, messages, kind) => {
    kinds.push(kind)
    return kinds.length === 1 ? '我听着。' : 'NO'
  }
  await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
  assert.deepEqual(kinds, ['fish', 'monitor'])
})
