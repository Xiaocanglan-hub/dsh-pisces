// 双流（dual）：A 暗栏 / B 顺序。
// 全部用假 llm / 假 next，不连网、不连 ollama；重点钉住 n10/n11/n18 的三条硬约束：
//   1) 监听器同步返回 AsyncIterable；
//   2) depth 护栏包住迭代，第二轮调用不会递归先算；
//   3) 约束进 system，但一个字都不许出现在回答里。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  attachDual,
  makeDualListener,
  needsPlan,
  renderConstraints,
  DEFAULT_DUAL,
  DRAFT_INSTRUCTION,
  FALLBACK_TEXT,
  PLAN_SYSTEM,
  TRIGGERS,
} from '../lib/dual.js'

const PLAN = '{"want":"想让他留下","blockedBy":"怕问了显得黏人","line":"问他去哪了"}'
const ANSWER = '主答'

/** 一条把文本拆成 3 字一块的假流；带 block-end 全文，模拟真机 chunk 形状。 */
async function* textStream(text) {
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 3) {
    yield { type: 'text-delta', index: 0, text: s.slice(i, i + 3) }
  }
  yield { type: 'block-end', index: 0, block: { type: 'text', index: 0, text: s } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/**
 * 假 waterfall：
 * - `llm.stream(options)` 把 options 交给监听器链；
 * - 监听器调用 next() 才落到 adapter；depth>0 时监听器自己会 next()；
 * - adapter 是唯一"模型调用"边界，calls 里记 PLANN 和 E。
 */
function makeHost({
  planRaw = PLAN,
  answer = ANSWER,
  planThrows = null,
  eThrows = null,
} = {}) {
  const calls = []
  const handlers = []
  let eFailures = eThrows ? 1 : 0

  function adapter(options) {
    const kind = options?.system === PLAN_SYSTEM ? 'plan' : 'e'
    calls.push({ kind, options })
    if (kind === 'plan' && planThrows) throw planThrows
    if (kind === 'e' && eFailures > 0) {
      eFailures -= 1
      throw eThrows
    }
    return textStream(kind === 'plan' ? planRaw : answer)
  }

  function dispatch(options) {
    let i = 0
    const next = () => {
      if (i >= handlers.length) return adapter(options)
      const handler = handlers[i]
      i += 1
      return handler(options, next)
    }
    return next()
  }

  return {
    calls,
    handlers,
    llm: { stream(options) { return dispatch(options) } },
  }
}

function makeBus() {
  const map = new Map()
  return {
    map,
    on(type, fn) {
      const set = map.get(type) ?? new Set()
      set.add(fn)
      map.set(type, set)
      return () => set.delete(fn)
    },
    off(type, fn) {
      const set = map.get(type)
      if (!set) return
      set.delete(fn)
      if (!set.size) map.delete(type)
    },
    count(type) { return map.get(type)?.size ?? 0 },
  }
}

function makeCtx() {
  const sub = makeBus()
  const ctx = {
    sub,
    injectCalls: 0,
    injectNames: [],
    inject(names, fn) {
      ctx.injectCalls += 1
      ctx.injectNames.push(names)
      return fn(sub)
    },
  }
  return { ctx, sub }
}

/** 装配：把 attachDual 注册的监听器接到假 waterfall 上。 */
function mount(host, { mode = 'A', enabled = true, cfg = {}, log = () => {} } = {}) {
  const { ctx, sub } = makeCtx()
  sub.llm = host.llm
  const dispose = attachDual(ctx, { enabled, mode, cfg, log })
  const listeners = [...(sub.map.get('llm/stream') ?? [])]
  host.handlers.push(...listeners)
  return { ctx, sub, dispose, listeners }
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const opts = (text, extra = {}) => ({
  provider: 'fake',
  model: 'fake-model',
  system: '你叫 Pisces，你在和他说话。',
  messages: [userMsg(text)],
  tools: [{ name: 'x' }],
  ...extra,
})

async function collect(stream) {
  assert.ok(stream, '流不能是 undefined')
  assert.equal(typeof stream[Symbol.asyncIterator], 'function', '必须同步返回 AsyncIterable')
  assert.equal(stream instanceof Promise, false, '不能返回 Promise')
  const chunks = []
  let text = ''
  let blockText = null
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk?.type === 'text-delta') text += String(chunk.text ?? '')
    if (chunk?.type === 'block-end' && typeof chunk?.block?.text === 'string') blockText = chunk.block.text
  }
  return { chunks, text, blockText }
}

test('dual：enabled:false 不注册监听，stats 是零', () => {
  const host = makeHost()
  const { ctx, listeners, dispose } = mount(host, { enabled: false })

  assert.equal(ctx.injectCalls, 0, '不该 inject llm')
  assert.equal(listeners.length, 0)
  assert.equal(host.calls.length, 0)

  const stats = dispose.stats()
  assert.equal(stats.mode, 'A')
  assert.equal(stats.plans, 0)
  assert.equal(stats.cacheHits, 0)
  assert.equal(stats.fallbacks, 0)
  assert.equal(stats.seconds, 0)
  assert.equal(stats.lastAt, null)

  host.llm.stream(opts('随便说一句'))
  assert.equal(host.calls.length, 1, '没有监听器，直接落到 adapter')
  dispose()
})

test('dual：监听器同步返回 AsyncIterable（不是 undefined / Promise），A 档也加了草稿指令', async () => {
  const host = makeHost({ answer: '草稿：先别急。\n---\n你回来了。' })
  mount(host)

  const returned = host.llm.stream(opts('你回来了？'))
  assert.notEqual(returned, undefined)
  assert.equal(typeof returned[Symbol.asyncIterator], 'function')
  assert.equal(returned instanceof Promise, false, 'Promise 会让宿主 for await 立刻炸')

  const out = await collect(returned)
  assert.equal(out.text, '你回来了。')
  assert.equal(host.calls.length, 1)
  assert.equal(host.calls[0].options.system.startsWith('你叫 Pisces'), true)
  assert.match(host.calls[0].options.system, /草稿/)
  assert.match(host.calls[0].options.system, /---/)
  assert.match(host.calls[0].options.system, /你真正要说出口的话/)
})

test('dual A：--- 之前的草稿被剥掉，之后原样保留', async () => {
  const host = makeHost({ answer: '草稿草稿，不算数。\n---\n第一句。\n第二句。' })
  mount(host)
  const out = await collect(host.llm.stream(opts('嗯。')))
  assert.equal(out.text, '第一句。\n第二句。')
  assert.equal(out.text.includes('草稿'), false)
  assert.equal(out.text.includes('---'), false)
})

test('dual A：没有 --- 就整段放行，不吞内容', async () => {
  const text = '今天风大，早点回来。'
  const host = makeHost({ answer: text })
  mount(host)
  const out = await collect(host.llm.stream(opts('外面冷吗？')))
  assert.equal(out.text, text)
})

test('dual A：剥完只剩空白 → 回吐兜底文本，不给空流', async () => {
  const host = makeHost({ answer: '只有草稿。\n---\n   ' })
  mount(host)
  const out = await collect(host.llm.stream(opts('嗯。')))
  assert.equal(out.text.trim(), FALLBACK_TEXT)
  assert.ok(out.text.length > 0)
})

test('dual A：没有 options.system 时草稿指令进 promptPrefix', async () => {
  const host = makeHost({ answer: '好。' })
  mount(host)
  const o = opts('嗯。')
  delete o.system
  const out = await collect(host.llm.stream(o))
  assert.equal(out.text, '好。')
  assert.match(host.calls[0].options.promptPrefix, /草稿/)
  assert.equal(host.calls[0].options.system, undefined)
})

test('dual B：普通闲聊不触发，R 不被调用', async () => {
  const host = makeHost()
  mount(host, { mode: 'B' })
  const out = await collect(host.llm.stream(opts('今天天气不错，我出去走走。')))

  assert.equal(out.text, ANSWER)
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 0)
  assert.equal(host.calls.filter((c) => c.kind === 'e').length, 1)
  assert.equal(host.calls[0].options.system, '你叫 Pisces，你在和他说话。', 'system 没被动过')
})

test('dual B：默认要求 tools——标题生成这类无 tools 请求不先算；requireTools:false 恢复', async () => {
  const long = '嗯'.repeat(DEFAULT_DUAL.triggerChars + 1)
  const noTools = opts(long)
  delete noTools.tools
  const withTools = opts(long)

  const host = makeHost()
  const { dispose } = mount(host, { mode: 'B' })
  await collect(host.llm.stream(noTools))
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 0, '没有 tools 不升级')
  assert.equal(dispose.stats().plans, 0)

  await collect(host.llm.stream(withTools))
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 1, '有 tools 才升级')
  assert.equal(dispose.stats().plans, 1)

  const host2 = makeHost()
  const second = mount(host2, { mode: 'B', cfg: { requireTools: false } })
  await collect(host2.llm.stream(noTools))
  assert.equal(host2.calls.filter((c) => c.kind === 'plan').length, 1, '关掉门槛后恢复只看词表/长度')
  assert.equal(second.dispose.stats().plans, 1)
})

test('dual B：长消息触发 → R 一次、约束进 system、E 原样出来', async () => {
  const host = makeHost()
  const { dispose } = mount(host, { mode: 'B' })
  const long = '嗯'.repeat(DEFAULT_DUAL.triggerChars + 1)

  const returned = host.llm.stream(opts(long))
  assert.equal(typeof returned[Symbol.asyncIterator], 'function')
  const out = await collect(returned)

  const plans = host.calls.filter((c) => c.kind === 'plan')
  const es = host.calls.filter((c) => c.kind === 'e')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].options.system, PLAN_SYSTEM)
  assert.equal('tools' in plans[0].options, false, '先算不能继承工具')
  assert.equal(plans[0].options.maxTokens, DEFAULT_DUAL.planMaxTokens)
  assert.equal(es.length, 1)
  assert.match(es[0].options.system, /想要：想让他留下/)
  assert.match(es[0].options.system, /挡住：怕问了显得黏人/)
  assert.match(es[0].options.system, /打算：问他去哪了/)
  assert.match(es[0].options.system, /一个字都不许出现在回答里/)
  assert.equal(out.text, ANSWER, 'E 的流原样出来，没有把约束念出来')

  const stats = dispose.stats()
  assert.equal(stats.plans, 1)
  assert.equal(stats.fallbacks, 0)
})

test('dual B：R 抛错 → 退回单次，fallbacks +1，E 仍然出来', async () => {
  const host = makeHost({ planThrows: new Error('R 挂了') })
  const { dispose } = mount(host, { mode: 'B' })
  const out = await collect(host.llm.stream(opts('我不想去。')))

  assert.equal(out.text, ANSWER)
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 1)
  assert.equal(host.calls.filter((c) => c.kind === 'e').length, 1)
  const stats = dispose.stats()
  assert.equal(stats.fallbacks, 1)
  assert.equal(stats.plans, 1)
})

test('dual B：约束解析失败 → 退回单次，fallbacks +1', async () => {
  const host = makeHost({ planRaw: '这不是 JSON' })
  const { dispose } = mount(host, { mode: 'B' })
  const out = await collect(host.llm.stream(opts('我不想去了。')))
  assert.equal(out.text, ANSWER)
  assert.equal(dispose.stats().fallbacks, 1)
})

test('dual B：E 抛错（还没吐字）→ 退回单次，E 仍然出来', async () => {
  const host = makeHost({ eThrows: new Error('E 挂了') })
  const { dispose } = mount(host, { mode: 'B' })
  const out = await collect(host.llm.stream(opts('我不想去。')))
  assert.equal(out.text, ANSWER)
  assert.equal(dispose.stats().fallbacks, 1)
})

test('dual 缓存：同一会话同一句只先算一次；TTL 过期后重算', async () => {
  let clock = 1_000
  const host = makeHost()
  const logs = []
  const { dispose } = mount(host, {
    mode: 'B',
    cfg: { cacheTTL: 1_000, cacheMax: 32, now: () => clock },
    log: (m) => logs.push(m),
  })

  const run = async (text, sessionId = 's1') => collect(host.llm.stream(opts(text, { sessionId })))

  await run('我不想去。')
  clock += 10
  await run('我不想去。')
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 1, '第二轮复用，不再先算')
  assert.equal(dispose.stats().cacheHits, 1)
  assert.ok(logs.some((m) => m.includes('复用上一轮的约束')))

  clock += 1_001
  await run('我不想去。')
  assert.equal(host.calls.filter((c) => c.kind === 'plan').length, 2, 'TTL 过期后重新先算')
  assert.equal(dispose.stats().plans, 2)
})

test('dual stats：只有 {mode,plans,cacheHits,fallbacks,seconds,lastAt}，不记内容', async () => {
  const host = makeHost()
  const { dispose } = mount(host, { mode: 'B' })
  await collect(host.llm.stream(opts('我不想去。')))

  const stats = dispose.stats()
  assert.deepEqual(Object.keys(stats).sort(), ['cacheHits', 'fallbacks', 'lastAt', 'mode', 'plans', 'seconds'])
  assert.equal(stats.mode, 'B')
  assert.equal(typeof stats.plans, 'number')
  assert.equal(typeof stats.cacheHits, 'number')
  assert.equal(typeof stats.fallbacks, 'number')
  assert.equal(typeof stats.seconds, 'number')
  assert.equal(typeof stats.lastAt, 'number')
  assert.equal(JSON.stringify(stats).includes('想让他留下'), false, '统计里不能有内容')
  assert.equal(JSON.stringify(stats).includes('我不想去'), false)
})

test('dual 触发词表：拒绝 / 边界 / 关系 / 自我怀疑 / 前后矛盾 各命中一条，闲聊不命中', () => {
  assert.equal(needsPlan('今天天气不错，我出去走走。'), false)
  assert.equal(needsPlan('好吧。'), false)
  assert.equal(needsPlan('我不想去了。'), true, '拒绝')
  assert.equal(needsPlan('你别管我的事。'), true, '边界')
  assert.equal(needsPlan('你还想和我在一起吗？'), true, '关系')
  assert.equal(needsPlan('我是不是做错了。'), true, '自我怀疑')
  assert.equal(needsPlan('你刚才明明说好要来的。'), true, '前后矛盾')
  assert.equal(needsPlan('嗯'.repeat(DEFAULT_DUAL.triggerChars)), false, '等于 400 不算长')
  assert.equal(needsPlan('嗯'.repeat(DEFAULT_DUAL.triggerChars + 1)), true, '超过 400 才算长')
  assert.equal(Object.keys(TRIGGERS).length, 5)
})

test('dual renderConstraints：空约束返回空；非空必带"一个字都不许出现在回答里"', () => {
  assert.equal(renderConstraints(null), '')
  assert.equal(renderConstraints({ want: '', blockedBy: '', line: '' }), '')
  const block = renderConstraints({ want: '留下', blockedBy: '怕', line: '问他去哪了' })
  assert.match(block, /想要：留下/)
  assert.match(block, /挡住：怕/)
  assert.match(block, /打算：问他去哪了/)
  assert.match(block, /一个字都不许出现在回答里/)
  assert.match(block, /不要复述/)
})

test('dual：makeDualListener 可单独使用，handler 同步返回 AsyncIterable', async () => {
  const host = makeHost()
  const listener = makeDualListener({ llm: host.llm, enabled: true, mode: 'A' })
  host.handlers.push(listener)
  const returned = host.llm.stream(opts('嗯。'))
  assert.equal(typeof returned[Symbol.asyncIterator], 'function')
  const out = await collect(returned)
  assert.equal(out.text, ANSWER)
  assert.equal(typeof listener.stats, 'function')
})
