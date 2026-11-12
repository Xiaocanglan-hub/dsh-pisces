import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoomRuntime } from '../lib/room-runtime.js'
import { createSetup, markRoomWelcomeSent } from '../lib/setup.js'
import { WELCOME } from '../lib/welcome.js'

async function collect(it) {
  let text = ''
  for await (const chunk of it) text += chunk?.text || ''
  return text
}

function fakeLlm(fn) {
  const calls = []
  const llm = {
    stream: async (options) => {
      calls.push(options)
      const text = await fn(options)
      return (async function* () { yield { type: 'text-delta', text } })()
    },
  }
  return { llm, calls }
}

test('room-runtime：welcome 3 连不落、只发一次', async () => {
  let current = createSetup({ mode: 'both', together: true })
  const saved = []
  const { llm, calls } = fakeLlm(async () => '不该调用')
  const rt = createRoomRuntime({
    llm,
    getSetup: () => current,
    saveSetup: (s) => { current = s; saved.push(s) },
  })
  const it = rt.handle({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(it.__piscesNoRecord, true)
  const text = await collect(it)
  assert.equal(text, [WELCOME.roomReminder, WELCOME.roomReminder, WELCOME.roomReminder].join('\n\n'))
  assert.equal(saved.length, 1)
  assert.equal(current.roomWelcomeSent, true)
  assert.equal(calls.length, 0)
  assert.equal(rt.info().welcomes, 1)
})

test('room-runtime：普通一轮虚拟调用，子调用带 __piscesRoom', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const { llm, calls } = fakeLlm(async (options) => {
    return String(options.system).includes('客厅监测') ? '先坐下。' : '我听着。'
  })
  const turns = []
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    fishSystem: 'F',
    piscesSystem: 'P',
    onTurn: (turn) => { turns.push(turn) },
  })
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '今天有点累' }] }))
  assert.equal(text, '【普通鱼】我听着。\n【派希丝】先坐下。')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((o) => o.__piscesRoom === true))
  assert.equal(rt.info().roomCalls, 1)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user, '今天有点累')
  assert.equal(turns[0].text, text)
})

test('room-runtime：点名只叫被点的角色', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const { llm, calls } = fakeLlm(async () => '我在。')
  const rt = createRoomRuntime({ llm, getSetup: () => setup, fishSystem: 'F', piscesSystem: 'P' })
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '派希丝，你说' }] }))
  assert.equal(text, '【派希丝】我在。')
  assert.equal(calls.length, 1)
})

test('room-runtime：教学写 teaching，不虚拟调用', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const appended = []
  const { llm, calls } = fakeLlm(async () => '不该调用')
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    getStore: () => ({ append: (ev) => appended.push(ev) }),
  })
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '他问我怎么办，我拿不定' }] }))
  assert.match(text, /先说结论/)
  assert.equal(calls.length, 0)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'teaching')
  assert.equal(appended[0].meta.lessonId, 'judgment-first')
  assert.equal(rt.info().teachings, 1)
})

test('room-runtime：不是客厅就交回宿主', () => {
  const { llm } = fakeLlm(async () => 'x')
  const rt = createRoomRuntime({ llm, getSetup: () => createSetup({ mode: 'pisces' }) })
  assert.equal(rt.handle({ messages: [] }), null)
})
