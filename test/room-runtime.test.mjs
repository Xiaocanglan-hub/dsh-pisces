import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoomRuntime, isRoomCall } from '../lib/room-runtime.js'
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

test('room-runtime：没门票不开门，贴通行码就开门', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const { llm, calls } = fakeLlm(async () => '不该调用')
  let ticketOpen = false
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    fishSystem: 'F',
    piscesSystem: 'P',
    roomTicket: {
      consume: (text) => {
        if (String(text).includes('ABC123')) {
          ticketOpen = true
          return true
        }
        return false
      },
      open: () => {},
      active: () => ticketOpen,
    },
  })
  const locked = await collect(rt.handle({ messages: [{ role: 'user', content: '在吗' }] }))
  assert.match(locked, /还没开门/)
  const opened = await collect(rt.handle({ messages: [{ role: 'user', content: 'ABC123' }] }))
  assert.equal(opened, '门开了。')
  // 这两轮都没跑客厅子调用。
  assert.equal(calls.length, 0)
})

test('room-runtime：普通一轮虚拟调用，子调用不再带 __piscesRoom', async () => {
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
  assert.equal(text, '【普通鱼】我听着。\n\n【派希丝】先坐下。')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((o) => o.__piscesRoom !== true))
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

test('room-runtime：教学时妹妹先答一句、派希丝主动教，并写 teaching', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const appended = []
  const { llm, calls } = fakeLlm(async () => '我拿不定。')
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    getStore: () => ({ append: (ev) => appended.push(ev) }),
  })
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '他问我怎么办，我拿不定' }] }))
  assert.match(text, /【普通鱼】我拿不定。/)
  assert.match(text, /先说结论/)
  assert.equal(calls.length, 1)
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

test('room-runtime：阶段标记走完会清空，卡在哪一步看得见', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const { llm, calls } = fakeLlm(async (options) => {
    return String(options.system).includes('客厅监测') ? '先坐下。' : '我听着。'
  })
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    fishSystem: 'F',
    piscesSystem: 'P',
  })
  await collect(rt.handle({ messages: [{ role: 'user', content: '今天有点累' }] }))
  const info = rt.info()
  assert.equal(info.phase, '')
  assert.equal(info.callIndex, 2)
  assert.equal(info.lastCallKind, 'monitor')
  assert.ok(info.lastCallMs >= 0)
  assert.equal(info.lastCallError, '')
  assert.equal(calls.length, 2)
})

test('room-runtime：子调用卡住会被 abort，不让整轮挂住', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const llm = {
    stream: (options) => (async function* () {
      // 永不产出 chunk；只等 abort。没有 signal 就真的挂住（那才是这条回归要防的）。
      await new Promise((resolve) => {
        const signal = options.signal
        if (!signal) return
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })(),
  }
  const logs = []
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    fishSystem: 'F',
    piscesSystem: 'P',
    callTimeoutMs: 40,
    log: (m) => logs.push(m),
  })
  const started = Date.now()
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '今天有点累' }] }))
  const elapsed = Date.now() - started
  assert.equal(text, '')
  assert.ok(elapsed < 1500, `elapsed ${elapsed}`)
  const info = rt.info()
  assert.equal(info.errors, 1)
  assert.match(info.lastError, /超时/)
  assert.equal(info.lastCallError, '子调用超时')
  assert.equal(info.phase, '')
  assert.ok(info.callIndex >= 1)
})

test('room-runtime：阶段留痕写到 writeTrace，卡住时能事后看', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const patches = []
  const llm = {
    stream: (options) => (async function* () {
      await new Promise((resolve) => {
        const signal = options.signal
        if (!signal) return
        if (signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    })(),
  }
  const rt = createRoomRuntime({
    llm,
    getSetup: () => setup,
    fishSystem: 'F',
    piscesSystem: 'P',
    callTimeoutMs: 40,
    writeTrace: (patch) => patches.push(patch),
  })
  await collect(rt.handle({ messages: [{ role: 'user', content: '今天有点累' }] }))
  const phases = patches.map((p) => p.phase)
  assert.equal(phases[0], 'turn-start')
  assert.ok(phases.includes('fish'))
  // 超时是被吃成 result.error 的（不抛），所以这一轮会走到 turn-end；
  // 事后看这条文件能看到「卡在 fish、然后一轮结束、errors:1」。
  assert.equal(phases[phases.length - 1], 'turn-end')
  const info = rt.info()
  assert.equal(info.errors, 1)
  assert.match(info.lastError, /超时/)
  assert.equal(info.lastCallError, '子调用超时')
})

// 2026-11-14 真机：宿主把子调用的分发推迟到迭代时才发生，同步 depth 已经落回去，
// 于是重进 onStream → handle → 新 generator，一秒几百次，最后整个宿主死掉
// （room\last-turn.json 里 roomCalls 8318）。护栏必须活到迭代结束 + 盖 symbol。
test('room-runtime：子调用的 assistant 消息要带 source（宿主会读 source.replayState）', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const seen = []
  const llm = {
    stream: async (options) => {
      seen.push(options)
      return (async function* () { yield { type: 'text-delta', index: 0, text: '嗯。' } })()
    },
  }
  const rt = createRoomRuntime({ llm, getSetup: () => setup, fishSystem: 'F', piscesSystem: 'P' })
  const messages = [
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '在' },
  ]
  await collect(rt.handle({ messages, provider: 'deepseek-account', model: 'v4' }))
  assert.ok(seen.length >= 1)
  const bad = seen
    .flatMap((o) => (Array.isArray(o.messages) ? o.messages : []))
    .filter((m) => m && m.role === 'assistant' && !m.source)
  assert.equal(bad.length, 0, `assistant 消息缺 source: ${JSON.stringify(bad)}`)
  // content 必须是 block 数组：宿主 serialize() 直接对 content 调 flatMap。
  const badContent = seen
    .flatMap((o) => (Array.isArray(o.messages) ? o.messages : []))
    .filter((m) => m && !Array.isArray(m.content))
  assert.equal(badContent.length, 0, `content 不是数组: ${JSON.stringify(badContent)}`)
  // 补出来的 source 要指向宿主给的 provider/model，否则 forAdapter 会当成别的路由重放。
  const withSource = seen
    .flatMap((o) => (Array.isArray(o.messages) ? o.messages : []))
    .find((m) => m && m.role === 'assistant' && m.source)
  assert.equal(withSource.source.kind, 'model')
  assert.equal(withSource.source.provider, 'deepseek-account')
  assert.equal(withSource.source.model, 'v4')
})

test('room-runtime：子调用护栏活到迭代之后（防宿主重进）', async () => {
  const setup = markRoomWelcomeSent(createSetup({ mode: 'both', together: true }))
  const seen = []
  const marked = []
  const llm = {
    stream: (options) => ({
      [Symbol.asyncIterator]: () => (async function* () {
        // 迭代时才「分发」：老代码到这一步 depth 已经落回 0。
        seen.push(isRoomCall(options))
        marked.push(options[Symbol.for('dsh-pisces.room-call')] === true)
        yield { type: 'text-delta', index: 0, text: '我听着。' }
      })(),
    }),
  }
  const rt = createRoomRuntime({ llm, getSetup: () => setup, fishSystem: 'F', piscesSystem: 'P' })
  const text = await collect(rt.handle({ messages: [{ role: 'user', content: '今天有点累' }] }))
  assert.ok(seen.length >= 1)
  assert.ok(seen.every(Boolean), `isRoomCall: ${JSON.stringify(seen)}`)
  assert.ok(marked.every(Boolean), '子调用的 options 要盖 symbol')
  assert.match(text, /普通鱼/)
})
