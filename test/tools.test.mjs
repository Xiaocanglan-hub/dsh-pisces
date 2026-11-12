// 工具面（M5）：七个基础动作 + 成年鱼五个特权动作。
// 用假 ctx 和假 store，只验"注册了什么、回执长什么样"，不碰真宿主。
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolDefs, registerTools, buildDevState, buildTrace } from '../lib/tools.js'
import { dayOf } from '../lib/util.js'
import { FIXED_PERSONA } from '../lib/persona.js'

function makeCtx() {
  const defs = []
  return {
    defs,
    ctx: {
      tools: {
        register(def) {
          defs.push(def)
          return () => {}
        },
      },
    },
  }
}

/** 内存 store：append 记调用，diaryPut 按真库语义做 INSERT OR REPLACE（同一天覆盖）。 */
function makeStore() {
  const diary = new Map()
  const events = []
  const calls = { append: [], diaryPut: [], metaSet: [] }
  return {
    calls,
    events,
    async append(input) {
      calls.append.push(input)
      const event = { id: `ev_test${calls.append.length}`, ...input }
      events.push(event)
      return event
    },
    readAll() {
      return events
    },
    diaryAll() {
      return [...diary.entries()].map(([day, row]) => ({ day, ...row }))
    },
    diaryPut(rows) {
      calls.diaryPut.push(rows.map((r) => ({ ...r })))
      for (const r of rows) diary.set(String(r.day), { text: String(r.text ?? ''), at: Number(r.at) || 0 })
      return rows.length
    },
    savedDiary(day) {
      return diary.get(String(day))?.text ?? ''
    },
  }
}

/** 默认给齐七个动作需要的依赖；overrides 里传 null 就等于"宿主没提供这个能力"。 */
function base(overrides = {}) {
  const { store: storeOverride, ...rest } = overrides
  const store = storeOverride || makeStore()
  const deps = {
    getStore: () => store,
    log: () => {},
    patchCard: async () => ({ ok: true, decision: 'applied', rev: 3, reasons: ['八道闸都过了'] }),
    look: async ({ limit }) => ({
      ok: true,
      titles: Array.from({ length: limit }, (_, i) => ({ title: `视频${i + 1}`, up: `up${i + 1}` })),
    }),
    speak: async () => ({ ok: true }),
    guide: {
      GUIDE_TOPICS: ['first-meet', 'seed'],
      guideFor: (topic) => `关于「${topic}」的引导。`,
      nextStep: () => ({ topic: 'first-meet', text: '先跟她说一句你今天的事。', why: '还没聊过。' }),
    },
    check: async () => '[她挺好] 天数 90 · 事件 96 · 问题 1 · 好感 42 · 上次整理 2026-11-09',
    ...rest,
  }
  return { store, deps }
}

function setup(overrides = {}) {
  const { store, deps } = base(overrides)
  const { ctx, defs } = makeCtx()
  const result = registerTools(ctx, deps)
  const tool = (name) => {
    const def = defs.find((d) => d.name === name)
    assert.ok(def, `没有注册 ${name}`)
    return def
  }
  return { store, deps, ctx, defs, result, tool }
}

const reply = async (def, args) => def.execute(args)

test('tools：基础注册 7 个，名字都是 pisces_* 且不重复', () => {
  const { defs, result } = setup()
  assert.equal(result.ok, true)
  assert.equal(result.count, 7)
  assert.equal(defs.length, 7)
  assert.equal(result.names.length, 7)
  assert.equal(new Set(result.names).size, 7)
  for (const name of result.names) assert.match(name, /^pisces_[a-z]+(_[a-z]+)*$/)
  assert.deepEqual(result.names, [
    'pisces_remember',
    'pisces_recall',
    'pisces_ask',
    'pisces_card_edit',
    'pisces_diary',
    'pisces_look',
    'pisces_speak',
  ])
})

test('tools：传 demo 后 12 个，含 pisces_self / pisces_teach / pisces_guide / pisces_check / pisces_nickname', async () => {
  const { defs, result, tool } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true, nickname: true },
    selfView: async () => ({ ok: true, view: { day: 90, split: true } }),
    teach: async (topic) => `关于「${topic}」的一条具体建议。`,
    setNickname: async (name) => ({ ok: true, name }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.count, 12)
  assert.equal(defs.length, 12)
  for (const n of ['pisces_self', 'pisces_teach', 'pisces_guide', 'pisces_check', 'pisces_nickname']) {
    assert.ok(result.names.includes(n), `少了 ${n}`)
  }
  assert.deepEqual(await reply(tool('pisces_teach'), { topic: 'start' }), {
    text: '关于「start」的一条具体建议。',
  })
})

test('tools：patchCard / look / speak 为 null 时对应工具不注册', () => {
  const cases = [
    ['patchCard', 'pisces_card_edit'],
    ['look', 'pisces_look'],
    ['speak', 'pisces_speak'],
  ]
  for (const [dep, name] of cases) {
    const { result } = setup({ [dep]: null })
    assert.equal(result.count, 6)
    assert.ok(!result.names.includes(name), `${dep}=null 时不该有 ${name}`)
  }

  const { result } = setup({ patchCard: null, look: null, speak: null })
  assert.equal(result.count, 4)
  assert.deepEqual(result.names, ['pisces_remember', 'pisces_recall', 'pisces_ask', 'pisces_diary'])
})

test('tools：remember 成功回 [记下了 ev_…]，失败回 [没记下]，都不回显她的话', async () => {
  const { store, tool } = setup()
  const text = '这是一句只有我自己知道的话。'
  const ok = await reply(tool('pisces_remember'), { text, type: 'refusal', refs: ['ev_a'] })
  assert.deepEqual(ok, { text: '[记下了 ev_test1]' })
  assert.equal(store.calls.append.length, 1)
  assert.deepEqual(store.calls.append[0], { type: 'refusal', text, refs: ['ev_a'], source: 'tool' })
  assert.ok(!ok.text.includes(text))

  const fail = setup({ getStore: async () => { throw new Error('还没准备好') } })
  assert.deepEqual(await reply(fail.tool('pisces_remember'), { text }), { text: '[没记下]' })
})

test('tools：recall 命中带 id + 日期 + 截断正文；没命中回 [没翻到]', async () => {
  const long = '风'.repeat(200)
  const recCalls = []
  const { tool } = setup({
    rec: async (opts) => {
      recCalls.push(opts)
      return { items: [{ id: 'ev_hit', day: '2026-11-09', type: 'utterance', text: long, score: 9 }] }
    },
  })
  const hit = await reply(tool('pisces_recall'), { query: '风', k: 99 })
  assert.match(hit.text, /ev_hit/)
  assert.match(hit.text, /2026-11-09/)
  assert.ok(hit.text.includes('…'), '正文应该被截断')
  assert.ok(!hit.text.includes(long), '不该整段回显')
  assert.deepEqual(recCalls[0], { query: '风', k: 8, budget: 800 })

  const miss = setup({ rec: async () => ({ items: [] }) })
  assert.deepEqual(await reply(miss.tool('pisces_recall'), { query: '没有的事' }), { text: '[没翻到]' })
})

test('tools：card_edit applied → [改好了 rev N]；rejected → [先没改：…]', async () => {
  let forwarded = null
  const applied = setup({
    patchCard: async (args) => {
      forwarded = args
      return { ok: true, decision: 'applied', rev: 5, reasons: [] }
    },
  })
  const args = { kind: 'bond', target: '他', text: '他今天把茶放在我手边。', evidence: ['ev_1'] }
  const ok = await reply(applied.tool('pisces_card_edit'), args)
  assert.deepEqual(ok, { text: '[改好了 rev 5]' })
  assert.deepEqual(forwarded, args)
  assert.ok(!ok.text.includes(args.text))

  const rejected = setup({
    patchCard: async () => ({ ok: false, decision: 'rejected', rev: 2, reasons: ['冷却：刚改过'] }),
  })
  assert.deepEqual(await reply(rejected.tool('pisces_card_edit'), args), {
    text: '[先没改：冷却：刚改过]',
  })
})

test('tools：diary 回执带当天日期，同一天接在后面（diaryPut 一次调用写一份合并文本）', async () => {
  const { store, tool } = setup()
  const diary = tool('pisces_diary')
  const today = dayOf(Date.now())

  const first = await reply(diary, { text: '今天风很大。' })
  assert.deepEqual(first, { text: `[写进日记了：${today}]` })
  assert.equal(store.calls.diaryPut.length, 1, '一次调用只写一次日记')
  assert.equal(store.calls.diaryPut[0].length, 1)
  assert.equal(store.calls.diaryPut[0][0].day, today)
  assert.equal(store.savedDiary(today), '今天风很大。')

  // 真库 diaryPut 是 INSERT OR REPLACE：同一天再写若不合并就会覆盖。
  // 所以这里按它的语义断言——第二次调用落库的文本必须同时包含两段。
  const second = await reply(diary, { text: '晚饭吃面。' })
  assert.deepEqual(second, { text: `[写进日记了：${today}]` })
  assert.equal(store.calls.diaryPut.length, 2)
  assert.equal(store.calls.diaryPut[1].length, 1)
  const stored = store.savedDiary(today)
  assert.ok(stored.includes('今天风很大。'))
  assert.ok(stored.includes('晚饭吃面。'))
  assert.equal(store.calls.diaryPut[1][0].text, stored, '最后一次 diaryPut 的文本就是落库文本')
})

test('tools：demo 有四个特权但 guide / check 依赖缺失时只注册 9 个', () => {
  const { result } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true },
    selfView: async () => ({ ok: true, view: { day: 90 } }),
    teach: async (topic) => `关于「${topic}」的一条具体建议。`,
    guide: null,
    check: null,
  })
  assert.equal(result.count, 9)
  assert.ok(!result.names.includes('pisces_guide'))
  assert.ok(!result.names.includes('pisces_check'))
})

test('tools：pisces_guide 不给 topic 走 nextStep（带 why），给 topic 走 guideFor', async () => {
  const calls = []
  const { tool } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true },
    selfView: async () => ({ ok: true, view: { day: 90 } }),
    teach: async () => '一段话',
    guide: {
      GUIDE_TOPICS: ['first-meet', 'daily'],
      guideFor: (topic) => {
        calls.push(['for', topic])
        return `「${topic}」的正文。`
      },
      nextStep: (opts) => {
        calls.push(['next', opts])
        return { topic: 'daily', text: '每天说两句今天的事。', why: '已经聊起来了。' }
      },
    },
  })

  const next = await reply(tool('pisces_guide'), {})
  assert.deepEqual(next, { text: '[下一步] 每天说两句今天的事。\n为什么：已经聊起来了。' })
  const body = await reply(tool('pisces_guide'), { topic: 'panel' })
  assert.deepEqual(body, { text: '「panel」的正文。' })
  assert.deepEqual(calls, [['next', undefined], ['for', 'panel']])
})

test('tools：pisces_check 没钥匙只回大概；钥匙对了才原样回 check 的一行；抛错回 [看不出]', async () => {
  const demo = { selfInspect: true, teach: true, guide: true, check: true }
  const view = async () => ({ ok: true, view: { day: 90 } })
  const ok = setup({
    demo,
    selfView: view,
    teach: async () => '一段话',
    verifyDevkey: (k) => k === 'right-key',
    check: async () => '[她挺好] 天数 3 · 事件 5 · 问题 0 · 好感 12 · 上次整理 2026-11-09',
  })
  const vague = await reply(ok.tool('pisces_check'), {})
  assert.equal(vague.text, '[看着没大毛病] 日子照走，没出什么事')
  assert.ok(!/天数|事件|好感/.test(vague.text), '没钥匙不给数字')
  const passed = await reply(ok.tool('pisces_check'), { key: 'right-key' })
  assert.match(passed.text, /天数 3/)
  assert.match(passed.text, /事件 5/)
  assert.match(passed.text, /好感 12/)

  const bad = setup({
    demo,
    selfView: view,
    teach: async () => '一段话',
    verifyDevkey: (k) => k === 'right-key',
    check: async () => {
      throw new Error('库坏了')
    },
  })
  assert.deepEqual(await reply(bad.tool('pisces_check'), { key: 'right-key' }), { text: '[看不出] 面板没读出来' })
})

test('tools：每个工具的 parameters / output 都是标准 JSON Schema，render 返回 text 块', () => {
  const { defs } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true, nickname: true },
    selfView: async () => ({ ok: true, view: { day: 3 } }),
    teach: async () => '一段话',
    setNickname: async (name) => ({ ok: true, name }),
  })
  assert.equal(defs.length, 12)
  for (const def of defs) {
    assert.equal(typeof def.name, 'string')
    assert.equal(typeof def.description, 'string')
    assert.equal(typeof def.execute, 'function')

    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.parameters.properties, 'object')
    assert.ok(Array.isArray(def.parameters.required))
    assert.equal(def.parameters.additionalProperties, false)

    assert.equal(def.output.schema.type, 'object')
    assert.ok(Array.isArray(def.output.schema.required))
    assert.ok(def.output.schema.required.includes('text'))
    assert.equal(def.output.schema.properties.text.type, 'string')
    assert.equal(typeof def.output.render, 'function')
    assert.deepEqual(def.output.render({}, { text: '回执' }), [{ type: 'text', text: '回执' }])
  }
  assert.equal(new Set(defs.map((d) => d.name)).size, defs.length)
})

test('tools：没有 ctx.tools.register 时返回 {ok:false}，不抛', () => {
  const { deps } = base()
  assert.doesNotThrow(() => registerTools(undefined, deps))
  assert.deepEqual(registerTools(undefined, deps), { ok: false, count: 0, names: [] })
  assert.deepEqual(registerTools({}, deps), { ok: false, count: 0, names: [] })
  assert.deepEqual(registerTools({ tools: {} }, deps), { ok: false, count: 0, names: [] })
})

test('tools：成年鱼自查默认只回大概（天数/有没有事/分流），不给计数', async () => {
  const view = {
    day: 90,
    beliefs: ['一', '二', '三'],
    refusals: ['a', 'b'],
    scars: ['x'],
    split: true,
    dominance: 0.65,
    weight: 0.87,
    order: 'R>E',
    mode: { split: true, dominance: 0.65 },
  }
  const { tool } = setup({
    demo: { selfInspect: true, teach: true },
    selfView: async () => ({ ok: true, view }),
    teach: async () => '一段话',
  })
  const out = await reply(tool('pisces_self'), {})
  assert.equal(out.text, '[天 90 · 还记着些事 · 分流了]')
  assert.ok(!/3|2|1|判断|拒绝|疤/.test(out.text.replace('天 90', '')), '没验钥匙不给计数')
  assert.ok(!/0\.65|0\.87/.test(out.text), '不许出现 dominance / 权重数字')
  assert.ok(!/dominance|weight|权重|主导|order/i.test(out.text), '不许出现这些词')
  assert.ok(tool('pisces_self').parameters.properties.key, '要留一个钥匙参数给验过的人')
})

test('tools：成年鱼自查验过钥匙才回计数；钥匙不对照旧只给大概', async () => {
  const view = {
    day: 90,
    beliefs: ['一', '二', '三'],
    refusals: ['a', 'b'],
    scars: ['x'],
    split: true,
    dominance: 0.65,
  }
  const { tool } = setup({
    demo: { selfInspect: true },
    verifyDevkey: (key) => key === 'right-key',
    selfView: async () => ({ ok: true, view }),
  })
  const withKey = await reply(tool('pisces_self'), { key: 'right-key' })
  assert.equal(withKey.text, '[天 90 · 判断 3 · 拒绝 2 · 疤 1 · 分流了]')
  const wrongKey = await reply(tool('pisces_self'), { key: 'nope' })
  assert.equal(wrongKey.text, '[天 90 · 还记着些事 · 分流了]')
  assert.ok(!/判断|拒绝|疤/.test(wrongKey.text), '钥匙不对不给计数')
})

test('tools：成年鱼 12 个含 pisces_nickname；回执 [记下了，以后我叫…] / [没改：…]', async () => {
  const seen = []
  const { result, tool } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true, nickname: true },
    selfView: async () => ({ ok: true, view: { day: 90 } }),
    teach: async () => '一段话',
    setNickname: async (name) => {
      seen.push(name)
      return name === '小鱼' ? { ok: true, name } : { ok: false, reason: '这本来就是我的名字' }
    },
  })

  assert.equal(result.count, 12)
  assert.ok(result.names.includes('pisces_nickname'), '成年鱼该有 pisces_nickname')
  assert.deepEqual(await reply(tool('pisces_nickname'), { name: '小鱼' }), {
    text: '[记下了，以后我叫小鱼]',
  })
  assert.deepEqual(await reply(tool('pisces_nickname'), { name: '派希丝' }), {
    text: '[没改：这本来就是我的名字]',
  })
  assert.deepEqual(seen, ['小鱼', '派希丝'])
})

test('tools：普通鱼仍 7 个，给了 setNickname 也不注册 pisces_nickname', () => {
  const { result } = setup({ setNickname: async (name) => ({ ok: true, name }) })
  assert.equal(result.count, 7)
  assert.equal(result.names.includes('pisces_nickname'), false)
})

test('tools：成年鱼 13 个，含 pisces_dev', () => {
  const { result } = setup({
    demo: { selfInspect: true, teach: true, guide: true, check: true, nickname: true, devkey: true },
    selfView: async () => ({ ok: true, view: { day: 90 } }),
    teach: async () => '一段话',
    setNickname: async (name) => ({ ok: true, name }),
    verifyDevkey: (key) => key === 'GOOD',
  })
  assert.equal(result.count, 13)
  assert.equal(result.names.includes('pisces_dev'), true)
  // 普通鱼不注册：demo 里没有 devkey 标记时工具面仍是 7 个基础动作。
  const plain = setup({ verifyDevkey: () => true })
  assert.equal(plain.result.count, 7)
  assert.equal(plain.result.names.includes('pisces_dev'), false)
})

test('tools：pisces_dev 钥匙不对只回 [没改：钥匙不对]，一条事件都不写', async () => {
  const { store, tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
  })
  const out = await reply(tool('pisces_dev'), { key: 'BAD', action: 'set', text: '你要更安静。' })
  assert.deepEqual(out, { text: '[没改：钥匙不对]' })
  assert.equal(store.calls.append.length, 0)
  // get 也要先验钥匙，不能把当前改动漏给没钥匙的人。
  const read = await reply(tool('pisces_dev'), { key: 'BAD', action: 'get' })
  assert.deepEqual(read, { text: '[没改：钥匙不对]' })
})

test('tools：pisces_dev set 后 get 回 overlay，rev 递增；clear 之后回 [还没有改动]', async () => {
  const { store, tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
  })
  const dev = tool('pisces_dev')

  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'get' }), { text: '[还没有改动]' })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'set', text: '你要更安静。' }), {
    text: '[记下了 rev 1]',
  })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'get' }), { text: '你要更安静。' })

  const ev = store.events.find((e) => e?.meta?.kind === 'dev-persona')
  assert.equal(ev.type, 'meta')
  assert.equal(ev.text, 'dev-persona:1')
  assert.deepEqual(ev.meta, { kind: 'dev-persona', text: '你要更安静。', rev: 1 })

  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'set', text: '再少说一点。' }), {
    text: '[记下了 rev 2]',
  })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'get' }), { text: '再少说一点。' })

  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'clear' }), { text: '[清掉了]' })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'get' }), { text: '[还没有改动]' })
  const last = store.events[store.events.length - 1]
  assert.equal(last.text, 'dev-persona:3')
  assert.deepEqual(last.meta, { kind: 'dev-persona', text: null, rev: 3 })
})

test('tools：pisces_dev trace 钥匙对 → 回执是人话（第 … 天 / 归因 / 判断），不带权重字段名', async () => {
  const events = [
    { seq: 1, id: 'ev_a1', type: 'utterance', text: '他说今天风大', day: '2026-11-09', ts: 1 },
    { seq: 2, id: 'ev_a2', type: 'utterance', text: '她问要不要开窗', day: '2026-11-09', ts: 2 },
    { seq: 3, id: 'ev_a3', type: 'utterance', text: '那我给你留一盏灯', day: '2026-11-10', ts: 3 },
  ]
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    // index 的 trace 就是"取数 + buildTrace"；这里直接给同一份数据，验工具面这一层。
    trace: async ({ limit }) =>
      buildTrace({
        events,
        derived: { day: 91, beliefs: [{ text: '先算一遍再开口' }, { text: '风大的日子适合待在家' }] },
        mind: { order: 'E>R', band: 'i', dominance: 0.38, n: 5 },
        affinity: { value: 31, label: '眼熟' },
        questions: [
          { status: 'open', text: '猫为什么踩奶' },
          { status: 'open', text: '他今天没来' },
        ],
        attrib: [
          { seq: 1, label: 'i' },
          { seq: 2, label: 'd' },
          { seq: 3, label: 'null' },
        ],
        limit,
      }),
  })

  const out = await reply(tool('pisces_dev'), { key: 'GOOD', action: 'trace' })
  assert.match(out.text, /\[现在\] 第 91 天 · 事件 3 · 主导 E>R（感性偏多 0\.62）· 好感 眼熟 31/)
  assert.match(out.text, /\[归因\] 最近 3 条：1 理性 \/ 1 感性 \/ 1 拿不准/)
  assert.match(out.text, /\[判断\] 最近 2 条：/)
  assert.match(out.text, /\[悬着\] 2 条：猫为什么踩奶 \/ 他今天没来/)
  assert.match(out.text, /\[刚说\] 那我给你留一盏灯/)
  // 归因是新的在前；每条只带一段截断正文 + 事件 id。
  assert.ok(out.text.indexOf('ev_a3') < out.text.indexOf('ev_a1'))
  // 不是 JSON、不出现权重原始字段名、不回显钥匙、不倒事件全量。
  assert.equal(out.text.trim().startsWith('{'), false)
  assert.ok(!/dominance|weight|权重|order/i.test(out.text))
  assert.equal(out.text.includes('GOOD'), false)
  assert.equal(out.text.split('\n').length, 8, '现在是 1 + 归因头 1 + 归因 3 + 判断/悬着/刚说')
})

test('tools：pisces_dev trace 钥匙不对 → [没改：钥匙不对]，trace 一次都不调', async () => {
  let calls = 0
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: () => false,
    trace: async () => {
      calls += 1
      return '不该出现'
    },
  })
  assert.deepEqual(await reply(tool('pisces_dev'), { key: 'BAD', action: 'trace' }), {
    text: '[没改：钥匙不对]',
  })
  assert.equal(calls, 0)
})

test('tools：pisces_dev trace 抛错 → [看不出：…]，不崩；没有 trace 依赖 → [看不出：库没读到]', async () => {
  const bad = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    trace: async () => {
      throw new Error('库坏了')
    },
  })
  assert.deepEqual(await reply(bad.tool('pisces_dev'), { key: 'GOOD', action: 'trace' }), {
    text: '[看不出：库坏了]',
  })

  // index 没注入 trace（比如还没接上/没有库）时不许抛，也不许落到 [没改：没记下来]。
  const missing = setup({ demo: { devkey: true }, verifyDevkey: () => true })
  assert.deepEqual(await reply(missing.tool('pisces_dev'), { key: 'GOOD', action: 'trace' }), {
    text: '[看不出：库没读到]',
  })
})

test('tools：pisces_dev action:card 钥匙对 + 合法正文 → 调 devCard，回 [卡改了 rev N]', async () => {
  const seen = []
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    devCard: async ({ text }) => {
      seen.push(text)
      return { ok: true, rev: 4 }
    },
  })
  // 抬头前面允许空行；传进去的是去掉首尾空白后的正文。
  const out = await reply(tool('pisces_dev'), {
    key: 'GOOD',
    action: 'card',
    text: '\n\n# 我\n\n生日 3 月 14 日。\n',
  })
  assert.deepEqual(out, { text: '[卡改了 rev 4]' })
  assert.deepEqual(seen, ['# 我\n\n生日 3 月 14 日。'])
})

test('tools：pisces_dev action:card 钥匙不对 / 不以「# 我」开头 / 超 2000 字 → 拒，devCard 一次都不调', async () => {
  let calls = 0
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    devCard: async () => {
      calls += 1
      return { ok: true, rev: 1 }
    },
  })
  const dev = tool('pisces_dev')
  assert.deepEqual(await reply(dev, { key: 'BAD', action: 'card', text: '# 我\n\n生日 3 月 14 日。' }), {
    text: '[没改：钥匙不对]',
  })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'card', text: '生日 3 月 14 日。' }), {
    text: '[没改：卡要以「# 我」开头]',
  })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'card', text: `# 我\n\n${'从'.repeat(2001)}` }), {
    text: '[没改：太长了]',
  })
  assert.equal(calls, 0)
})

test('tools：pisces_dev action:card 写失败 → [没改：<原因>]；抛错也不崩', async () => {
  const bad = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    devCard: async () => ({ ok: false, reason: '写卡失败：磁盘满了' }),
  })
  assert.deepEqual(await reply(bad.tool('pisces_dev'), { key: 'GOOD', action: 'card', text: '# 我\n\n生日。' }), {
    text: '[没改：写卡失败：磁盘满了]',
  })

  const broken = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    devCard: async () => {
      throw new Error('卡目录没了')
    },
  })
  assert.deepEqual(await reply(broken.tool('pisces_dev'), { key: 'GOOD', action: 'card', text: '# 我\n\n生日。' }), {
    text: '[没改：卡目录没了]',
  })
})

test('tools：pisces_dev action:card 没有 devCard 依赖 → [没改：这条没接上]', async () => {
  const { tool } = setup({ demo: { devkey: true }, verifyDevkey: () => true })
  assert.deepEqual(await reply(tool('pisces_dev'), { key: 'GOOD', action: 'card', text: '# 我\n\n生日 3 月 14 日。' }), {
    text: '[没改：这条没接上]',
  })
})

test('tools：pisces_dev action:card-read 钥匙对 → [卡 rev N] + 卡正文原样；没卡/读失败各有回执', async () => {
  const body = '生日 3 月 14 日。\n\n怕水，但喜欢下雨的声音。'
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    readCardSelf: async () => ({ ok: true, rev: 5, text: body }),
  })
  // text 对只读动作没有意义，必须被忽略。
  const out = await reply(tool('pisces_dev'), { key: 'GOOD', action: 'card-read', text: '这段不该被用上' })
  assert.deepEqual(out, { text: `[卡 rev 5]\n${body}` })
  assert.ok(!out.text.includes('这段不该被用上'))

  const empty = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    readCardSelf: async () => ({ ok: false, reason: '卡还没写' }),
  })
  assert.deepEqual(await reply(empty.tool('pisces_dev'), { key: 'GOOD', action: 'card-read' }), {
    text: '[卡还没写]',
  })

  const broken = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    readCardSelf: async () => {
      throw new Error('卡目录没了')
    },
  })
  assert.deepEqual(await reply(broken.tool('pisces_dev'), { key: 'GOOD', action: 'card-read' }), {
    text: '[没读到：卡目录没了]',
  })
})

test('tools：pisces_dev card-read / persona 钥匙不对 → [没改：钥匙不对]，读依赖一次都不调', async () => {
  let calls = 0
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: () => false,
    readCardSelf: async () => {
      calls += 1
      return { ok: true, rev: 1, text: '不该出现' }
    },
    personaText: () => {
      calls += 1
      return '不该出现'
    },
  })
  const dev = tool('pisces_dev')
  assert.deepEqual(await reply(dev, { key: 'BAD', action: 'card-read' }), { text: '[没改：钥匙不对]' })
  assert.deepEqual(await reply(dev, { key: 'BAD', action: 'persona' }), { text: '[没改：钥匙不对]' })
  assert.equal(calls, 0)
})

test('tools：pisces_dev action:persona → [固定段] + FIXED_PERSONA 原样（含大肥鱼 / 派希丝）', async () => {
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    personaText: () => FIXED_PERSONA,
  })
  const out = await reply(tool('pisces_dev'), { key: 'GOOD', action: 'persona', text: '这段不该被用上' })
  assert.equal(out.text, `[固定段]\n${FIXED_PERSONA}`)
  assert.ok(out.text.includes('大肥鱼'))
  assert.ok(out.text.includes('派希丝'))
})

test('tools：pisces_dev card-read / persona 没有依赖 → [没读到：这条没接上]，不崩', async () => {
  const { tool } = setup({ demo: { devkey: true }, verifyDevkey: () => true })
  const dev = tool('pisces_dev')
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'card-read' }), {
    text: '[没读到：这条没接上]',
  })
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'persona' }), {
    text: '[没读到：这条没接上]',
  })
})

test('tools：pisces_dev fixed-set 写覆盖 → [固定段改了，下一轮生效]；fixed-get 先默认后覆盖；fixed-clear 回默认', async () => {
  const calls = { set: [], clear: 0 }
  let stored = null
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    fixedSet: async ({ text }) => {
      calls.set.push(text)
      stored = text
      return { ok: true }
    },
    fixedGet: async () => ({ ok: true, overridden: stored != null, text: stored ?? FIXED_PERSONA }),
    fixedClear: async () => {
      calls.clear += 1
      stored = null
      return { ok: true }
    },
  })
  const dev = tool('pisces_dev')

  // 没覆盖时回默认固定段，并标「默认」。
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'fixed-get' }), {
    text: `[固定段（默认）]\n${FIXED_PERSONA}`,
  })

  // set 会去掉首尾空白再交给依赖；回执照口径。
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'fixed-set', text: '  你是潮水边的一块软玻璃。\n' }), {
    text: '[固定段改了，下一轮生效]',
  })
  assert.deepEqual(calls.set, ['你是潮水边的一块软玻璃。'])

  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'fixed-get' }), {
    text: '[固定段（已覆盖）]\n你是潮水边的一块软玻璃。',
  })

  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'fixed-clear' }), {
    text: '[回到默认固定段]',
  })
  assert.equal(calls.clear, 1)
  assert.deepEqual(await reply(dev, { key: 'GOOD', action: 'fixed-get' }), {
    text: `[固定段（默认）]\n${FIXED_PERSONA}`,
  })
})

test('tools：pisces_dev fixed-* 钥匙不对 → [没改：钥匙不对]，读写依赖一次都不调', async () => {
  let calls = 0
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: () => false,
    fixedGet: async () => {
      calls += 1
      return { ok: true, overridden: false, text: '不该出现' }
    },
    fixedSet: async () => {
      calls += 1
      return { ok: true }
    },
    fixedClear: async () => {
      calls += 1
      return { ok: true }
    },
  })
  const dev = tool('pisces_dev')
  for (const action of ['fixed-get', 'fixed-set', 'fixed-clear']) {
    assert.deepEqual(await reply(dev, { key: 'BAD', action, text: '不该写进去' }), {
      text: '[没改：钥匙不对]',
    })
  }
  assert.equal(calls, 0)
})

test('tools：pisces_dev action:state 钥匙对 + devState 依赖 → 回执含 [完整状态]/天数/事件数/[归因]', async () => {
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: (key) => key === 'GOOD',
    // index 的 devState 就是"取全量数据 + buildDevState"；这里直接给同一份数据，验工具面这一层。
    devState: async () =>
      buildDevState({
        events: [
          { seq: 1, type: 'utterance', text: '他说今天风大' },
          { seq: 2, type: 'refusal', text: '那我先不说' },
          { seq: 3, type: 'dream_sim', text: '窗口的雨', meta: { status: 'untested' } },
          { seq: 4, type: 'dream_sim', text: '沙发底下', meta: { status: 'rejected' } },
          { seq: 5, type: 'meta', text: '', meta: { kind: 'dream_observed' } },
        ],
        derived: {
          day: 91,
          beliefs: [{ text: '先算一遍再开口' }, { text: '风大的日子适合待在家' }],
          refusals: [{ text: '那我先不说' }, { text: '不想出去' }],
          scars: [{ text: '不想出去' }, { text: '不想说' }],
        },
        mind: { order: 'E>R', band: 'i', dominance: 0.38 },
        affinity: { value: 35.4, label: '眼熟' },
        questions: [
          { status: 'open', text: '猫为什么踩奶' },
          { status: 'open', text: '他今天没来' },
        ],
        attrib: [
          { seq: 1, label: 'i' },
          { seq: 2, label: 'd' },
          { seq: 3, label: 'null' },
        ],
      }),
  })

  const out = await reply(tool('pisces_dev'), { key: 'GOOD', action: 'state' })
  // 事件数含样本历史（这里给几条就报几条），天数/主导/好感都是人话。
  assert.match(out.text, /\[完整状态\] 第 91 天 · 事件 5 · 主导 E>R（偏感性 0\.62）· 好感 眼熟 35/)
  assert.match(out.text, /\[归因\] 3 条：1 理性 \/ 1 感性 \/ 1 拿不准/)
  assert.match(out.text, /\[判断\] 2 条：/)
  assert.match(out.text, /\[悬着\] 2 条：猫为什么踩奶 \/ 他今天没来/)
  assert.match(out.text, /\[梦\] 2 条（其中 1 条没做成）/)
  assert.match(out.text, /\[核实\] 1 条/)
  assert.match(out.text, /\[疤\] 2 道 · 拒绝 2 次/)
  assert.match(out.text, /\[最近\] 3 条：/)
  // 不是 JSON、不出现权重原始字段名、不回显钥匙；行数固定 8 行。
  assert.equal(out.text.trim().startsWith('{'), false)
  assert.ok(!/dominance|weight|order/i.test(out.text))
  assert.equal(out.text.includes('GOOD'), false)
  assert.equal(out.text.split('\n').length, 8)
})

test('tools：pisces_dev action:state 钥匙不对 → [没改：钥匙不对]，devState 一次都不调', async () => {
  let calls = 0
  const { tool } = setup({
    demo: { devkey: true },
    verifyDevkey: () => false,
    devState: async () => {
      calls += 1
      return '不该出现'
    },
  })
  assert.deepEqual(await reply(tool('pisces_dev'), { key: 'BAD', action: 'state' }), {
    text: '[没改：钥匙不对]',
  })
  assert.equal(calls, 0)
})

test('tools：pisces_dev action:state 依赖抛错 → [看不出：…]，不崩；缺依赖 → [没读到：这条没接上]', async () => {
  const bad = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    devState: async () => {
      throw new Error('库坏了')
    },
  })
  assert.deepEqual(await reply(bad.tool('pisces_dev'), { key: 'GOOD', action: 'state' }), {
    text: '[看不出：库坏了]',
  })

  // index 没注入 devState（比如还没接上）时回「没接上」，不许抛，也不许假装看到了。
  const missing = setup({ demo: { devkey: true }, verifyDevkey: () => true })
  assert.deepEqual(await reply(missing.tool('pisces_dev'), { key: 'GOOD', action: 'state' }), {
    text: '[没读到：这条没接上]',
  })
})

test('tools：pisces_dev fixed-* 没有依赖 → [没改：这条没接上]；fixed-set 写失败回原因', async () => {
  const missing = setup({ demo: { devkey: true }, verifyDevkey: () => true })
  const dev = missing.tool('pisces_dev')
  for (const action of ['fixed-get', 'fixed-set', 'fixed-clear']) {
    assert.deepEqual(await reply(dev, { key: 'GOOD', action, text: '你是潮水。' }), {
      text: '[没改：这条没接上]',
    })
  }

  // 文件层拒写（太长 / 空）时，把原因原样带回来。
  const refused = setup({
    demo: { devkey: true },
    verifyDevkey: () => true,
    fixedSet: async () => ({ ok: false, reason: '太长了' }),
  })
  assert.deepEqual(await reply(refused.tool('pisces_dev'), { key: 'GOOD', action: 'fixed-set', text: '你是潮水。' }), {
    text: '[没改：太长了]',
  })
})


