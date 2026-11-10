// console（观测台）：纯函数 handle + 一页 HTML + 挂载。不起服务器，直接调路由。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { dayOf } from '../lib/util.js'
import { writeSeed } from '../lib/seed.js'
import { EventEmitter } from 'node:events'
import { handle, page, readBody, registerConsole, toNodeHandler, ADULT_LABEL, PREFIX } from '../lib/console.js'
import { SCHEMA, publicSettings, readSettings, writeSettings } from '../lib/settings.js'
import { NICKNAME_MAX, nicknameOf, setNickname as writeNickname } from '../lib/nickname.js'
import { BAIDU_FILE, TBS_API, USERINFO_API, loginBaidu, readBaidu } from '../lib/baidu.js'

const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const DAY = 86_400_000

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-console-'))
  return createStore({ root, forceJsonl: true })
}

/** 打一个观测台请求：url 自动带前缀，body 自动序列化。 */
function request(method, url, body) {
  const req = { method, url: PREFIX + url }
  if (body !== undefined) req.body = typeof body === 'string' ? body : JSON.stringify(body)
  return req
}

async function call(method, url, body, deps) {
  return handle(request(method, url, body), deps)
}

function payload(res) {
  assert.equal(typeof res.body, 'string')
  return JSON.parse(res.body)
}

function assertJsonHeaders(res) {
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
}

/** 假 Node 响应：记下 writeHead/end 的调用，验证 handler 真的回了包。 */
function fakeRes() {
  const out = { status: null, headers: null, body: '', ended: false, writeHeadCalls: 0, endCalls: 0 }
  const res = {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
      out.writeHeadCalls += 1
      return res
    },
    end(chunk) {
      out.body += chunk == null ? '' : String(chunk)
      out.ended = true
      out.endCalls += 1
      return res
    },
  }
  return { res, out }
}

test('/state：天数/事件/主导/归因/悬着/梦/核实/最近 5 条都在；dual 只给次数', async () => {
  const store = await mkStore()
  const seedTs = Date.now() - 2 * DAY
  await writeSeed({ store, texts: ['她很安静，喜欢看窗外。'], bias: 'rational', now: seedTs })
  const u1 = await store.append({ ts: NOW - 9000, type: 'utterance', text: '今天有点累。', source: 'tool' })
  await store.append({ ts: NOW - 8000, type: 'refusal', text: '不想说这个。', source: 'tool' })
  await store.append({ ts: NOW - 7000, type: 'meta', text: 'seen:abc', source: 'system' })
  const dream = await store.append({
    ts: NOW - 6000,
    type: 'dream_sim',
    text: '（梦）她把猫放在窗台上。',
    meta: { status: 'untested', thread: '猫', hypothesis: '猫会不会回来？' },
    source: 'system',
  })
  await store.append({
    ts: NOW - 5000,
    type: 'dream_sim',
    text: '（这次没做成梦：场景抄了问题）',
    meta: { status: 'rejected', rejected: ['场景抄了问题'] },
    source: 'system',
  })
  await store.append({
    ts: NOW - 4000,
    type: 'meta',
    text: 'dream_observed',
    meta: { kind: 'dream_observed', dream: dream.id, evidence: u1.id },
    source: 'system',
  })
  store.attribPut([
    { seq: 1, day: dayOf(NOW), label: 'd', conf: 0.9 },
    { seq: 2, day: dayOf(NOW), label: 'i', conf: 0.7 },
    { seq: 3, day: dayOf(NOW), label: 'null', conf: 0.3 },
  ])
  store.questionPut([
    { key: 'k-open', kind: 'about', text: '猫为什么回来？', refs: [], since: NOW - 8000, status: 'open', source: 'utterance', at: NOW },
    { key: 'k-done', kind: 'about', text: '已经答过的问题？', refs: [], since: NOW - 7000, status: 'answered', source: 'utterance', at: NOW },
  ])

  const mind = { describe: () => ({ order: 'R>E', dominance: 0.65, band: 'd', splitAt: null }) }
  const dual = () => ({ mode: 'A', plans: 3, cacheHits: 2, fallbacks: 1, seconds: 0.4, lastAt: NOW, extra: '不该出现' })
  const res = await call('GET', '/state', undefined, { store, mind, dual })
  assert.equal(res.status, 200)
  assertJsonHeaders(res)
  const body = payload(res)

  assert.equal(body.ok, true)
  assert.equal(body.day, 3)
  assert.equal(body.events, 7)
  assert.equal(body.order, 'R>E')
  assert.equal(body.dominance, 0.65)
  assert.deepEqual(body.attribution, { d: 1, i: 1, null: 1, total: 3 })
  assert.equal(body.openQuestions, 1)
  assert.equal(body.dreams, 1) // rejected 不算一次梦
  assert.equal(body.dreamsRejected, 1)
  assert.equal(body.verified, 1)
  assert.equal(body.recent.length, 4) // meta 事件不上墙
  for (const e of body.recent) assert.ok(['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer', 'dream_sim'].includes(e.type))
  assert.ok(!body.recent.some((e) => e.text.includes('seen:abc')))
  assert.equal(body.recent[0].type, 'dream_sim') // 倒序：最新在前
  assert.equal(body.demo, null) // 普通鱼

  // dual 只给次数：白名单之外的内容一个都不许带出来。
  assert.deepEqual(body.dual, { mode: 'A', plans: 3, cacheHits: 2, fallbacks: 1, seconds: 0.4, lastAt: NOW })
  assert.equal(body.dual.extra, undefined)

  // 没开双流就是 null。
  const noDual = payload(await call('GET', '/state', undefined, { store, mind }))
  assert.equal(noDual.dual, null)

  // 没库 → 503，不抛。
  const noStore = payload(await call('GET', '/state', undefined, {}))
  assert.equal(noStore.ok, false)
  assert.match(noStore.error, /没装 store/)
  store.close()
})

test('/state：成年鱼 demo 取自事件流（meta.kind=demo）；普通鱼 null；deps.state/demoInfo 缺省不抛', async () => {
  // 普通鱼：空库 → null。
  const plain = await mkStore()
  const plainBody = payload(await call('GET', '/state', undefined, { store: plain }))
  assert.equal(plainBody.ok, true)
  assert.equal(plainBody.demo, null)
  plain.close()

  // 成年鱼：事件流里一条 meta.kind='demo'（判据同工具面，不看配置）。
  const adult = await mkStore()
  await adult.append({
    ts: NOW - 1000,
    type: 'meta',
    text: 'demo:adult',
    meta: { kind: 'demo', name: '派希丝', label: ADULT_LABEL },
    source: 'system',
  })
  const adultBody = payload(await call('GET', '/state', undefined, { store: adult }))
  assert.deepEqual(adultBody.demo, { name: '派希丝', label: ADULT_LABEL })
  adult.close()

  // service.state() 在时优先认它（连 store 都可以不给）：demo 原样透出、其他字段用它。
  const svcBody = payload(
    await call('GET', '/state', undefined, {
      state: () => ({ ok: true, day: 9, demo: { name: '派希丝', label: '来自 service' } }),
    }),
  )
  assert.equal(svcBody.ok, true)
  assert.equal(svcBody.day, 9)
  assert.deepEqual(svcBody.demo, { name: '派希丝', label: '来自 service' })

  // demoInfo 形状也认；它抛错/缺省时都不抛，退回事件流判断。
  const infoStore = await mkStore()
  const infoBody = payload(
    await call('GET', '/state', undefined, { store: infoStore, demoInfo: () => ({ ok: true, demo: true }) }),
  )
  assert.deepEqual(infoBody.demo, { name: '派希丝', label: ADULT_LABEL })

  const boomBody = payload(
    await call('GET', '/state', undefined, {
      store: infoStore,
      demoInfo: () => {
        throw new Error('demoInfo 炸了')
      },
    }),
  )
  assert.equal(boomBody.ok, true)
  assert.equal(boomBody.demo, null)
  infoStore.close()
})

test('/events：倒序、limit 生效且有 200 上限、type 过滤', async () => {
  const store = await mkStore()
  for (let i = 0; i < 200; i++) {
    await store.append({ ts: NOW + i, type: 'utterance', text: `第 ${i} 句。`, source: 'tool' })
  }
  for (let i = 0; i < 5; i++) {
    await store.append({ ts: NOW + 1000 + i, type: 'refusal', text: `不 ${i}。`, source: 'tool' })
  }

  const def = payload(await call('GET', '/events', undefined, { store }))
  assert.equal(def.count, 40)
  assert.equal(def.total, 205)
  assert.equal(def.limit, 40)
  assert.equal(def.events[0].text, '不 4。') // 最新在前

  const typed = payload(await call('GET', '/events?type=refusal', undefined, { store }))
  assert.equal(typed.count, 5)
  assert.ok(typed.events.every((e) => e.type === 'refusal'))

  const capped = payload(await call('GET', '/events?limit=999', undefined, { store }))
  assert.equal(capped.count, 200)
  assert.equal(capped.limit, 200)

  const three = payload(await call('GET', '/events?limit=3', undefined, { store }))
  assert.equal(three.count, 3)

  const junk = payload(await call('GET', '/events?limit=abc', undefined, { store }))
  assert.equal(junk.count, 40)

  const gone = payload(await call('GET', '/events', undefined, {}))
  assert.equal(gone.ok, false)
  store.close()
})

test('/dreams 与 /questions：形状、倒序、rejected 留痕、按 since 排', async () => {
  const store = await mkStore()
  const okDream = await store.append({
    ts: NOW - 3000,
    type: 'dream_sim',
    text: '（梦）猫从窗台跳下来。',
    meta: { status: 'untested', thread: '猫', hypothesis: '猫会不会回来？', test: '下次数一数' },
    source: 'system',
  })
  await store.append({
    ts: NOW - 2000,
    type: 'dream_sim',
    text: '（这次没做成梦：场景抄了问题）',
    meta: { status: 'rejected', rejected: ['场景抄了问题', '句数不对'] },
    source: 'system',
  })
  await store.append({
    ts: NOW - 1000,
    type: 'meta',
    text: 'dream_observed',
    meta: { kind: 'dream_observed', dream: okDream.id, evidence: 'ev_x' },
    source: 'system',
  })

  const dreams = payload(await call('GET', '/dreams', undefined, { store }))
  assert.equal(dreams.ok, true)
  assert.equal(dreams.count, 2)
  assert.equal(dreams.dreams[0].status, 'rejected') // 最新在前
  assert.deepEqual(dreams.dreams[0].rejected, ['场景抄了问题', '句数不对'])
  assert.equal(dreams.dreams[0].verified, false)
  assert.equal(dreams.dreams[1].hypothesis, '猫会不会回来？')
  assert.equal(dreams.dreams[1].verified, true)

  // 假 questions：故意给乱序，路由要按 since 排。
  const qs = {
    list: () => [
      { key: 'b', kind: 'about', text: '后', status: 'open', since: 200, refs: ['ev_2'] },
      { key: 'a', kind: 'to-you', text: '先', status: 'answered', since: 100 },
    ],
    setStatus: () => ({ ok: true }),
  }
  const q = payload(await call('GET', '/questions', undefined, { questions: qs }))
  assert.equal(q.ok, true)
  assert.equal(q.count, 2)
  assert.deepEqual(q.questions.map((x) => x.key), ['a', 'b'])
  assert.deepEqual(q.questions[1].refs, ['ev_2'])

  const none = payload(await call('GET', '/questions', undefined, {}))
  assert.equal(none.ok, false)
  assert.match(none.error, /questions/)
  store.close()
})

test('/answer：合法状态 200；非法状态/缺 key/坏 JSON 400；异常变 500', async () => {
  const calls = []
  const qs = {
    list: () => [],
    setStatus: (key, status) => {
      calls.push([key, status])
      return { ok: true }
    },
  }

  const good = await call('POST', '/answer', { key: 'k1', status: 'answered' }, { questions: qs })
  assert.equal(good.status, 200)
  assertJsonHeaders(good)
  assert.deepEqual(payload(good), { ok: true, key: 'k1', status: 'answered' })
  assert.deepEqual(calls, [['k1', 'answered']])

  const bad = await call('POST', '/answer', { key: 'k1', status: 'sleepy' }, { questions: qs })
  assert.equal(bad.status, 400)
  assert.match(payload(bad).error, /open \/ answered \/ dropped \/ observed/)
  assert.equal(calls.length, 1) // 被拒的没进库

  const noKey = await call('POST', '/answer', { status: 'dropped' }, { questions: qs })
  assert.equal(noKey.status, 400)

  const broken = await call('POST', '/answer', '{', { questions: qs })
  assert.equal(broken.status, 400)
  assert.match(payload(broken).error, /JSON/)

  const refused = payload(
    await call('POST', '/answer', { key: 'nope', status: 'dropped' }, { questions: { setStatus: () => ({ ok: false, reason: '没有这条问题' }) } }),
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.error, '没有这条问题')

  const thrown = await call('POST', '/answer', { key: 'k1', status: 'open' }, {
    questions: {
      setStatus: () => {
        throw new Error('库关了')
      },
    },
  })
  assert.equal(thrown.status, 500)
  assert.equal(payload(thrown).ok, false)

  const missing = payload(await call('POST', '/answer', { key: 'k', status: 'open' }, {}))
  assert.equal(missing.ok, false)
})

test('/nightly 与 /nightly/run：due+last；force/dryRun 透传', async () => {
  const LAST = NOW - 3600000
  const seen = []
  const nightly = {
    due: ({ now } = {}) => ({ ok: now === NOW, reason: now === NOW ? '' : '不在夜里' }),
    last: () => LAST,
    run: async ({ force, dryRun }) => {
      seen.push({ force, dryRun })
      return { ok: true, ran: true, steps: { reflect: { ok: true } } }
    },
  }

  const res = await call('GET', '/nightly', undefined, { nightly })
  assert.equal(res.status, 200)
  const info = payload(res)
  assert.equal(info.ok, true)
  assert.equal(info.last, LAST)
  assert.equal(info.due.ok, false) // now 是真实时间，不是测试的 NOW

  const run = await call('POST', '/nightly/run', { force: true, dryRun: true }, { nightly })
  assert.equal(run.status, 200)
  assert.equal(payload(run).ran, true)
  assert.deepEqual(seen, [{ force: true, dryRun: true }])

  await call('POST', '/nightly/run', {}, { nightly })
  assert.deepEqual(seen[1], { force: false, dryRun: false })

  const missing = payload(await call('GET', '/nightly', undefined, {}))
  assert.equal(missing.ok, false)
  const thrown = payload(
    await call('POST', '/nightly/run', {}, { nightly: { due: () => ({ ok: true }), run: () => { throw new Error('炸了') } } }),
  )
  assert.equal(thrown.ok, false)
})

test('/studies、/learn、/verify：装了就 200，没装就 503 且不抛', async () => {
  const store = await mkStore()
  store.studiesPut([
    { key: 'k1', question: '猫为什么会踩奶', facts: ['踩奶是幼态延续行为'], sources: [{ title: '百科', url: 'https://example.com' }], at: NOW },
  ])
  const studies = payload(await call('GET', '/studies', undefined, { store }))
  assert.equal(studies.ok, true)
  assert.equal(studies.count, 1)
  assert.equal(studies.studies[0].question, '猫为什么会踩奶')
  assert.deepEqual(studies.studies[0].facts, ['踩奶是幼态延续行为'])
  assert.equal((await call('GET', '/studies', undefined, {})).status, 503)

  const learned = []
  const learn = async ({ now }) => {
    learned.push(now)
    return { ok: true, studied: [{ key: 'k1' }] }
  }
  const learnRes = await call('POST', '/learn', { now: 123456789 }, { learn })
  assert.equal(learnRes.status, 200)
  assert.equal(payload(learnRes).result.ok, true)
  assert.deepEqual(learned, [123456789])
  assert.equal((await call('POST', '/learn', {}, {})).status, 503)

  const verify = ({ now }) => ({ scanned: 2, verified: 1, skipped: 0, pairs: [] })
  const verifyRes = await call('POST', '/verify', {}, { verify })
  assert.equal(verifyRes.status, 200)
  assert.equal(payload(verifyRes).result.scanned, 2)
  assert.equal((await call('POST', '/verify', {}, {})).status, 503)

  // 没装也不抛：三次调用都拿到 JSON。
  for (const res of [
    await call('GET', '/studies', undefined, {}),
    await call('POST', '/learn', {}, {}),
    await call('POST', '/verify', {}, {}),
  ]) {
    assert.equal(res.status, 503)
    assertJsonHeaders(res)
  }
  store.close()
})

test('/seed GET：没起点时成年鱼可领；有起点时 available:false、current 有内容', async () => {
  const store = await mkStore()
  const empty = payload(await call('GET', '/seed', undefined, { store }))
  assert.equal(empty.ok, true)
  assert.equal(empty.hasSeed, false)
  assert.equal(empty.canWrite, true)
  assert.equal(empty.current, null)
  assert.deepEqual(empty.limits, { fragments: 3, fragment: 200, total: 500 })
  assert.deepEqual(empty.biases.map((b) => b.id), ['balanced', 'rational', 'intuitive'])
  assert.deepEqual(empty.adult, {
    name: '派希丝',
    label: '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼',
    available: true,
  })

  await writeSeed({ store, texts: ['她很安静。', '喜欢看窗外。'], bias: 'intuitive', now: NOW - DAY })
  const filled = payload(await call('GET', '/seed', undefined, { store }))
  assert.equal(filled.hasSeed, true)
  assert.equal(filled.canWrite, false)
  assert.equal(filled.adult.available, false)
  assert.equal(filled.current.bias, 'intuitive')
  assert.equal(filled.current.biasName, '先凭感觉')
  assert.equal(filled.current.fragments.length, 2)
  assert.match(filled.current.text, /她很安静/)

  const none = payload(await call('GET', '/seed', undefined, {}))
  assert.equal(none.ok, false)
  assert.equal(none.error, '没装 seed')
  store.close()
})

test('POST /seed 与 POST /adopt：成功/失败都回 JSON，不抛', async () => {
  const store = await mkStore()
  // service 的 writeSeed 形状是 (texts, bias)，store 由闭包包住。
  const write = (texts, bias) => writeSeed({ store, texts, bias })
  const deps = { store, writeSeed: write }

  const ok = await call('POST', '/seed', { texts: ['她很安静。', '喜欢看窗外。'], bias: 'intuitive' }, deps)
  assert.equal(ok.status, 200)
  const okBody = payload(ok)
  assert.equal(okBody.ok, true)
  assert.equal(okBody.fragments.length, 2)
  assert.equal(okBody.chars, 11)
  assert.ok(store.readAll().some((e) => e.type === 'seed'))

  const again = await call('POST', '/seed', { texts: ['再来一次。'] }, deps)
  assert.equal(again.status, 400)
  assert.match(payload(again).error, /已经有起点/)

  const store2 = await mkStore()
  const badBias = await call(
    'POST',
    '/seed',
    { texts: ['随便。'], bias: 'wild' },
    { store: store2, writeSeed: (texts, bias) => writeSeed({ store: store2, texts, bias }) },
  )
  assert.equal(badBias.status, 400)
  assert.match(payload(badBias).error, /不认识的偏向/)

  const store3 = await mkStore()
  const blank = await call(
    'POST',
    '/seed',
    { texts: ['  ', ''] },
    { store: store3, writeSeed: (texts, bias) => writeSeed({ store: store3, texts, bias }) },
  )
  assert.equal(blank.status, 400)
  assert.match(payload(blank).error, /起点还是空的/)

  assert.equal((await call('POST', '/seed', { texts: ['x'] }, { store })).status, 503)

  const adopted = payload(await call('POST', '/adopt', {}, { adopt: () => ({ ok: true, count: 96 }) }))
  assert.equal(adopted.ok, true)
  assert.equal(adopted.name, '派希丝')

  const noAdopt = await call('POST', '/adopt', {}, { adopt: () => ({ ok: false, reason: '已经有起点了，不能再领养' }) })
  assert.equal(noAdopt.status, 400)
  assert.equal(payload(noAdopt).error, '已经有起点了，不能再领养')

  const boom = await call('POST', '/adopt', {}, { adopt: () => { throw new Error('样本没了') } })
  assert.equal(boom.status, 500)
  assert.equal(payload(boom).ok, false)

  assert.equal((await call('POST', '/adopt', {}, {})).status, 503)
  store.close()
  store2.close()
  store3.close()
})

test('POST /home：有 deps 调 service.home() 回 200；没装 503；失败照实回 400', async () => {
  let calls = 0
  const ok = await call(
    'POST',
    '/home',
    {},
    {
      home: () => {
        calls += 1
        return {
          ok: true,
          wsId: 'ws_home',
          sessionId: 'sess_home_1',
          workspaceTitle: '派希丝的家',
          sessionTitle: '与派希丝聊天',
          created: { workspace: true, session: true },
          dir: 'X',
        }
      },
    },
  )
  assert.equal(ok.status, 200)
  assertJsonHeaders(ok)
  const body = payload(ok)
  assert.equal(body.ok, true)
  assert.equal(body.wsId, 'ws_home')
  assert.equal(body.sessionId, 'sess_home_1')
  assert.deepEqual(body.created, { workspace: true, session: true })
  assert.equal(calls, 1, 'deps.home 被调到一次')

  // 没装 home → 503（和其他 dep 缺省的口径一致）
  const none = await call('POST', '/home', {}, {})
  assert.equal(none.status, 503)
  assert.equal(payload(none).ok, false)
  assert.equal(payload(none).error, '没装 home')

  // 服务缺失（可重试）照实回 400 + reason，并带上 retryable 给调用方判断
  const failed = await call(
    'POST',
    '/home',
    {},
    { home: () => ({ ok: false, reason: '宿主没有 workspaceRegistry 服务', retryable: true }) },
  )
  assert.equal(failed.status, 400)
  assert.equal(payload(failed).ok, false)
  assert.equal(payload(failed).error, '宿主没有 workspaceRegistry 服务')
  assert.equal(payload(failed).retryable, true)

  // 只收 POST
  assert.equal((await call('GET', '/home', undefined, { home: () => ({ ok: true }) })).status, 405)
})

test('未知路径 404 JSON；没有前缀的 url 也认', async () => {
  const res = await call('GET', '/nope', undefined, {})
  assert.equal(res.status, 404)
  assertJsonHeaders(res)
  assert.equal(payload(res).ok, false)

  assert.equal((await call('POST', '/nope', {}, {})).status, 404)

  const store = await mkStore()
  const bare = await handle({ method: 'GET', url: '/events?limit=1' }, { store })
  assert.equal(bare.status, 200)
  assert.equal(payload(bare).count, 0)
  store.close()
})

test('page()：script 能被 new Function 解析；只有 radio + 一个 textarea；成年鱼入口默认隐藏', () => {
  const html = page({})
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(scripts.length, 1)
  assert.doesNotThrow(() => new Function(scripts[0]))

  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
  assert.equal(inputs.length, 4)
  for (const tag of inputs) assert.match(tag, /type="radio"/)
  assert.equal((html.match(/<textarea\b/g) || []).length, 1)
  assert.doesNotMatch(html, /type="(text|number|range|hidden|search|email|password|checkbox)"/)

  for (const text of [
    '养鱼新手不要调整，默认就行',
    '上次整理',
    '只读面板：没有改人格、改记忆、编辑事件的入口',
    'startMode',
    'adultBox',
    '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼',
    '派希丝',
    '领养这条成年鱼',
    '她最近说的话',
    '悬着的事',
    '做过的梦',
    '她查到的',
    '双流',
  ]) {
    assert.ok(html.includes(text), `页面缺少：${text}`)
  }

  // 隐藏逻辑：不选 startMode 就整块隐藏；选中才显示。
  assert.match(html, /<div id="adultBox" hidden>/)
  assert.match(scripts[0], /adultBox\.hidden = !startMode\.checked/)

  // 没有性格滑条、没有好感度、没有数值输入。
  assert.ok(!html.includes('好感度'))
  assert.ok(!html.includes('性格滑条'))
})

test('registerConsole：挂 prefix 路由；没有 webServer 返回 {ok:false} 不抛', async () => {
  const captured = []
  let disposed = false
  const webServer = {
    register(spec) {
      captured.push(spec)
      return () => {
        disposed = true
      }
    },
  }
  const store = await mkStore()
  const nightly = { due: () => ({ ok: true }), last: () => null }
  const out = registerConsole({ get: (name) => (name === 'webServer' ? webServer : undefined) }, { store, nightly })

  assert.equal(out.ok, true)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].kind, 'prefix')
  assert.equal(captured[0].path, PREFIX)
  assert.equal(typeof captured[0].handler, 'function')
  assert.ok(captured[0].handler.length >= 2, 'handler 必须是 Node 风格 (req, res)')

  // handler 真的能路由：直接调挂上去的那一个，它会写 Node 响应。
  const { res, out: resp } = fakeRes()
  await captured[0].handler({ method: 'GET', url: PREFIX + '/nightly' }, res)
  assert.equal(resp.status, 200)
  assert.match(resp.headers['content-type'], /application\/json/)
  assert.equal(JSON.parse(resp.body).ok, true)
  assert.equal(resp.ended, true)

  out.dispose()
  assert.equal(disposed, true)

  // register 返回 {dispose} 而不是函数时也收下。
  let objDisposed = false
  const out2 = registerConsole(
    {
      get: () => ({
        register: () => ({
          dispose: () => {
            objDisposed = true
          },
        }),
      }),
    },
    {},
  )
  assert.equal(out2.ok, true)
  out2.dispose()
  assert.equal(objDisposed, true)

  assert.equal(registerConsole({}, {}).ok, false)
  assert.equal(registerConsole(null, {}).ok, false)
  assert.equal(
    registerConsole(
      { get: () => ({ register() { throw new Error('挂不上') } }) },
      {},
    ).ok,
    false,
  )
  store.close()
})

test('toNodeHandler：GET 写 Node 响应（200 + JSON），不是返回对象', async () => {
  const store = await mkStore()
  const handler = toNodeHandler({ store })
  const { res, out } = fakeRes()

  await handler({ method: 'GET', url: PREFIX + '/state' }, res)

  assert.equal(out.writeHeadCalls, 1)
  assert.equal(out.status, 200)
  assert.match(out.headers['content-type'], /application\/json/)
  assert.equal(out.headers['cache-control'], 'no-store')
  const body = JSON.parse(out.body)
  assert.equal(body.ok, true)
  assert.equal(typeof body.day, 'number')
  assert.equal(out.ended, true)
  store.close()
})

test('toNodeHandler：POST 从 data/end 读 body 并透传；空 body 是 undefined', async () => {
  const calls = []
  const questions = {
    list: () => [],
    setStatus: (key, status) => {
      calls.push([key, status])
      return { ok: true }
    },
  }
  const handler = toNodeHandler({ questions })
  const { res, out } = fakeRes()

  const req = new EventEmitter()
  req.method = 'POST'
  req.url = PREFIX + '/answer'
  const pending = handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ key: 'k9', status: 'answered' })))
  req.emit('end')
  await pending

  assert.equal(out.status, 200)
  assert.deepEqual(JSON.parse(out.body), { ok: true, key: 'k9', status: 'answered' })
  assert.deepEqual(calls, [['k9', 'answered']])
  assert.equal(out.ended, true)

  // 没有 body：readBody 返回 undefined（不是 {}），路由按缺 key 回 400。
  assert.equal(await readBody({ method: 'POST' }), undefined)
  assert.equal(await readBody(null), undefined)
  const empty = fakeRes()
  const req2 = new EventEmitter()
  req2.method = 'POST'
  req2.url = PREFIX + '/answer'
  const p2 = handler(req2, empty.res)
  req2.emit('end')
  await p2
  assert.equal(empty.out.status, 400)
})

test('toNodeHandler：内部抛错 → 500 JSON；res 缺 writeHead 也照样 end', async () => {
  const handler = toNodeHandler({})
  const { res, out } = fakeRes()
  const req = {
    method: 'GET',
    get url() {
      throw new Error('url 炸了')
    },
  }

  await handler(req, res)
  assert.equal(out.status, 500)
  assert.match(out.headers['content-type'], /application\/json/)
  const body = JSON.parse(out.body)
  assert.equal(body.ok, false)
  assert.match(body.error, /url 炸了/)
  assert.equal(out.ended, true)

  // res 只有 end（没有 writeHead）：照样 end，连接不会挂着。
  let endOnly = ''
  await handler(
    { method: 'GET', url: PREFIX + '/nope' },
    {
      end: (chunk) => {
        endOnly = String(chunk)
      },
    },
  )
  assert.match(endOnly, /没有这个接口/)

  // writeHead 自己抛错：也要继续 end。
  let endedAfterThrow = ''
  await handler(
    { method: 'GET', url: PREFIX + '/nope' },
    {
      writeHead() {
        throw new Error('头写不进去')
      },
      end: (chunk) => {
        endedAfterThrow = String(chunk)
      },
    },
  )
  assert.match(endedAfterThrow, /没有这个接口/)
})

test('/state：成年鱼带 reveal，被锁的统计字段在 JSON 里就是 null；名字/身份不遮', async () => {
  const store = await mkStore()
  const demo = await store.append({
    ts: Date.now() - 1000,
    type: 'meta',
    text: 'demo:adult',
    meta: { kind: 'demo', name: '派希丝', label: ADULT_LABEL },
    source: 'system',
  })
  // 领养后只聊了一句：深度 1，还是 L0，除了名字与身份其余全遮。
  await store.append({ ts: Date.now(), type: 'utterance', text: '在吗？', source: 'tool' })

  const body = payload(await call('GET', '/state', undefined, { store }))
  assert.equal(body.ok, true)
  assert.deepEqual(body.demo, { name: '派希丝', label: ADULT_LABEL })
  assert.equal(body.reveal.level, 0)
  assert.equal(body.reveal.depth, 1)
  assert.equal(body.reveal.baselineSeq, demo.seq)
  assert.equal(body.reveal.locked.day, true)
  assert.equal(body.reveal.locked.events, true)
  assert.equal(body.reveal.locked.attribution, true)
  assert.deepEqual(body.reveal.next, { level: 1, needEvents: 1, needDays: 1 })

  for (const name of ['day', 'events', 'order', 'dominance', 'attribution', 'openQuestions', 'dreams', 'verified', 'refusals', 'scars']) {
    assert.equal(body[name], null, `${name} 在 JSON 里就该是 null`)
    assert.equal(body.masked[name], true, `${name} 应该标 masked`)
  }
  assert.equal(body.band, null) // band 跟着主导一起遮
  store.close()
})

test('/state：普通鱼不加 reveal、不遮，字段与现在完全一致', async () => {
  const store = await mkStore()
  await writeSeed({ store, texts: ['她很安静，喜欢看窗外。'], bias: 'balanced', now: Date.now() - 2 * DAY })
  await store.append({ ts: Date.now() - 1000, type: 'utterance', text: '今天有点累。', source: 'tool' })

  const body = payload(await call('GET', '/state', undefined, { store }))
  assert.equal(body.ok, true)
  assert.equal(body.demo, null)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'reveal'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(body, 'masked'), false)
  assert.equal(body.day, 3) // 有起点 → deriveSelf 的天数，没被遮
  assert.equal(body.events, 2)
  assert.notEqual(body.attribution, null)
  assert.notEqual(body.order, null)
  assert.notEqual(body.dominance, null)
  store.close()
})

test('/state：普通鱼的 affinity 有数字（不遮），tier/label/nextAt 都在', async () => {
  const store = await mkStore()
  await writeSeed({ store, texts: ['她很安静，喜欢看窗外。'], bias: 'balanced', now: Date.now() - 2 * DAY })
  await store.append({ ts: Date.now() - 60_000, type: 'heard', text: '他说他今天早点回来。', source: 'owner' })

  const body = payload(await call('GET', '/state', undefined, { store }))
  assert.equal(body.demo, null)
  const aff = body.affinity
  assert.ok(aff && typeof aff === 'object', '/state 应该带 affinity')
  assert.equal(typeof aff.value, 'number', '普通鱼不遮，数字要给')
  assert.equal(aff.masked, false)
  assert.equal(aff.days, 2)
  assert.equal(aff.value, 12.5) // 初始 10 + 2 天分 1 + heard 1.5
  assert.equal(aff.tier, 0)
  assert.equal(aff.label, '陌生')
  assert.equal(aff.nextAt, 20)
  assert.equal(aff.earned, 2.5)
  assert.equal(aff.lost, 0)
  store.close()
})

test('/state：派希丝在 reveal.level<2 时 affinity 只留心不给数字，聊深了才给', async () => {
  const store = await mkStore()
  await store.append({
    ts: Date.now() - 1000,
    type: 'meta',
    text: 'demo:adult',
    meta: { kind: 'demo', name: '派希丝', label: ADULT_LABEL },
    source: 'system',
  })

  const maskedBody = payload(await call('GET', '/state', undefined, { store }))
  assert.equal(maskedBody.reveal.level < 2, true)
  const masked = maskedBody.affinity
  assert.equal(masked.masked, true)
  assert.equal(masked.value, null)
  assert.equal(masked.earned, null)
  assert.equal(masked.lost, null)
  // 心意看得见：档位/名字/下一档门槛始终给。
  assert.equal(masked.tier, 0)
  assert.equal(masked.label, '陌生')
  assert.equal(masked.nextAt, 20)

  // 领养后聊够 6 次 → reveal 升到 L2，数字才给出来。
  for (let i = 0; i < 6; i += 1) {
    await store.append({ ts: Date.now() + i, type: 'heard', text: '他说了一句。', source: 'owner' })
  }
  const openBody = payload(await call('GET', '/state', undefined, { store }))
  assert.ok(openBody.reveal.level >= 2)
  assert.equal(openBody.affinity.masked, false)
  assert.equal(typeof openBody.affinity.value, 'number')
  assert.equal(openBody.affinity.value, 19) // 10 + 6 × heard 1.5
  store.close()
})

// ---------------------------------------------------------------- demo 展示层过滤

/**
 * 造一条成年鱼：`sample` 条样本事件（前 `dreams` 条是梦）+ 最后一条 demo 标记，
 * 再可选在基线后追加 `after` 条领养后的新事件。返回 store 与关键事件，便于断言。
 */
async function mkAdultSamples({ sample = 96, dreams = 6, demoAt, after = 0 } = {}) {
  const store = await mkStore()
  const at = demoAt ?? Date.now() - 1000
  const start = at - sample * 60_000
  const sampleEvents = []
  for (let i = 0; i < sample; i += 1) {
    const isDream = i < dreams
    const ev = await store.append({
      ts: start + i * 60_000,
      type: isDream ? 'dream_sim' : 'utterance',
      text: isDream ? `（梦）样本 ${i}` : `样本 ${i}`,
      meta: isDream ? { status: 'untested', thread: `t${i}`, hypothesis: `h${i}` } : {},
      source: 'system',
    })
    sampleEvents.push(ev)
  }
  const demo = await store.append({
    ts: at,
    type: 'meta',
    text: 'demo:adult',
    meta: { kind: 'demo', name: '派希丝', label: ADULT_LABEL },
    source: 'system',
  })
  const fresh = []
  for (let i = 0; i < after; i += 1) {
    fresh.push(
      await store.append({ ts: at + (i + 1) * 1000, type: 'utterance', text: `领养后 ${i}`, source: 'tool' }),
    )
  }
  return { store, demo, sampleEvents, fresh }
}

test('/state demo：96 条样本 + demo 标记 + 0 条新事件 → recent 为空、dreams 0（数据仍在库里）', async () => {
  // demo 标记放 40 天前，让 reveal 到 L6 全开：这样 dreams 不是被遮成 null，能直接测到过滤后的 0。
  const { store } = await mkAdultSamples({ demoAt: Date.now() - 40 * DAY })
  const body = payload(await call('GET', '/state', undefined, { store }))

  assert.equal(body.ok, true)
  assert.deepEqual(body.demo, { name: '派希丝', label: ADULT_LABEL })
  assert.equal(body.reveal.level, 6)
  assert.deepEqual(body.recent, [])
  assert.equal(body.dreams, 0)
  assert.equal(body.dreamsRejected, 0)
  assert.equal(body.verified, 0)

  // 数据一条没少：样本 6 个梦还躺在事件流里，只是不上展示层。
  assert.equal(store.readAll().length, 97)
  assert.equal(store.readAll().filter((e) => e.type === 'dream_sim').length, 6)
  store.close()
})

test('/state demo：基线后新增 2 条 → recent 只含这 2 条（样本 90 天的话不上墙）', async () => {
  const { store } = await mkAdultSamples({ demoAt: Date.now() - 1000, after: 2 })
  const body = payload(await call('GET', '/state', undefined, { store }))

  assert.equal(body.recent.length, 2)
  assert.deepEqual(body.recent.map((e) => e.text), ['领养后 1', '领养后 0'])
  assert.ok(!body.recent.some((e) => e.text.startsWith('样本')))
  store.close()
})

test('/state 普通鱼：没有 demo 标记就不过滤，recent 仍是样本的最近几条', async () => {
  const store = await mkStore()
  for (let i = 0; i < 8; i += 1) {
    await store.append({ ts: NOW + i, type: 'utterance', text: `普通 ${i}`, source: 'tool' })
  }
  const body = payload(await call('GET', '/state', undefined, { store }))

  assert.equal(body.demo, null)
  assert.deepEqual(body.recent.map((e) => e.text), ['普通 7', '普通 6', '普通 5', '普通 4', '普通 3'])
  store.close()
})

test('/events demo：列表与 total 都只算基线之后；普通鱼仍是全量', async () => {
  const { store } = await mkAdultSamples({ demoAt: Date.now() - 1000, after: 12 })
  const res = payload(await call('GET', '/events?limit=10', undefined, { store }))

  assert.equal(res.count, 10)
  assert.equal(res.total, 12) // 96 条样本 + 1 条 demo 标记都不算
  assert.equal(res.events[0].text, '领养后 11')
  assert.ok(res.events.every((e) => e.text.startsWith('领养后')))

  // 普通鱼（没有 demo 标记）：全量照旧。
  const plain = await mkStore()
  for (let i = 0; i < 3; i += 1) await plain.append({ ts: NOW + i, type: 'utterance', text: `普通 ${i}` })
  const plainBody = payload(await call('GET', '/events?limit=10', undefined, { store: plain }))
  assert.equal(plainBody.total, 3)
  plain.close()
  store.close()
})

test('/dreams 与 /questions demo：样本里的梦/问题不显示；领养后的仍能显示', async () => {
  const { store, demo, sampleEvents } = await mkAdultSamples({ sample: 20, dreams: 2, demoAt: Date.now() - 1000 })
  const questions = { list: () => store.questionAll() }

  // 三条领养前的"问题"：refs 指向样本事件、没有 ref 只有 at、refs 里都是找不到的 id。
  store.questionPut([
    {
      key: 'q-sample-ref',
      kind: 'about',
      text: '样本里带出来的问题',
      refs: [sampleEvents[0].id],
      since: sampleEvents[0].ts,
      status: 'open',
      source: 'utterance',
      at: sampleEvents[0].ts,
    },
    {
      key: 'q-old-at',
      kind: 'about',
      text: '没有 ref 的老问题',
      refs: [],
      since: demo.ts - 1000,
      status: 'open',
      source: 'utterance',
      at: demo.ts - 1000,
    },
    {
      key: 'q-ghost-ref',
      kind: 'about',
      text: 'ref 找不到但时间早',
      refs: ['ev_不存在'],
      since: demo.ts - 500,
      status: 'open',
      source: 'utterance',
      at: demo.ts - 500,
    },
  ])
  store.studiesPut([{ key: 's-old', question: '样本期查到的', facts: ['旧事实'], sources: [], at: demo.ts - 5000 }])

  const dreams = payload(await call('GET', '/dreams', undefined, { store }))
  assert.equal(dreams.ok, true)
  assert.equal(dreams.count, 0)
  assert.deepEqual(dreams.dreams, [])

  const q = payload(await call('GET', '/questions', undefined, { store, questions }))
  assert.equal(q.ok, true)
  assert.equal(q.count, 0)
  assert.deepEqual(q.questions, [])

  const studies = payload(await call('GET', '/studies', undefined, { store }))
  assert.equal(studies.count, 0)

  // 领养后新增的梦/问题/查到的东西：照常显示（过滤只砍样本历史，不误伤新内容）。
  const fresh = await store.append({ ts: demo.ts + 1000, type: 'utterance', text: '领养后说的一句', source: 'tool' })
  await store.append({
    ts: demo.ts + 2000,
    type: 'dream_sim',
    text: '（梦）领养后做的梦',
    meta: { status: 'untested', thread: '猫', hypothesis: '会回来吗？' },
    source: 'system',
  })
  store.questionPut([
    {
      key: 'q-new',
      kind: 'about',
      text: '领养后的问题',
      refs: [fresh.id],
      since: fresh.ts,
      status: 'open',
      source: 'utterance',
      at: fresh.ts,
    },
  ])
  store.studiesPut([{ key: 's-new', question: '领养后查到的', facts: ['新事实'], sources: [], at: demo.ts + 3000 }])

  const dreams2 = payload(await call('GET', '/dreams', undefined, { store }))
  assert.equal(dreams2.count, 1)
  assert.equal(dreams2.dreams[0].text, '（梦）领养后做的梦')
  const q2 = payload(await call('GET', '/questions', undefined, { store, questions }))
  assert.equal(q2.count, 1)
  assert.equal(q2.questions[0].key, 'q-new')
  const studies2 = payload(await call('GET', '/studies', undefined, { store }))
  assert.equal(studies2.count, 1)
  assert.equal(studies2.studies[0].key, 's-new')
  store.close()
})

// ---------------------------------------------------------------- 设置中心

function settingsDeps(root) {
  return {
    settings: () => ({ ok: true, settings: publicSettings(readSettings(root)), schema: SCHEMA, root }),
    saveSettings: (patch) => {
      const r = writeSettings(root, patch)
      if (!r.ok) return r
      return { ok: true, settings: publicSettings(r.settings), changed: r.changed, needsRestart: r.needsRestart }
    },
  }
}

test('/settings：GET 回 settings/schema/root；POST {patch} 写入并回 changed/needsRestart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-console-settings-'))
  const deps = settingsDeps(root)

  const get = await call('GET', '/settings', undefined, deps)
  assert.equal(get.status, 200)
  assertJsonHeaders(get)
  const before = payload(get)
  assert.equal(before.ok, true)
  assert.equal(before.root, root)
  assert.ok(Array.isArray(before.schema) && before.schema.length > 0)
  assert.ok(before.schema.some((x) => x.path === 'tools.narrow'))
  assert.equal(before.settings.tools.narrow, false)
  // 反破甲默认开，隐藏：schema 不列、settings 对象里也不回。
  assert.equal(before.schema.some((x) => x.path === 'persona.guard'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(before.settings.persona, 'guard'), false)

  const post = await call('POST', '/settings', { patch: { tools: { narrow: true } } }, deps)
  assert.equal(post.status, 200)
  const after = payload(post)
  assert.equal(after.ok, true)
  assert.equal(after.settings.tools.narrow, true)
  assert.ok(after.changed.includes('tools.narrow'))
  assert.ok(after.needsRestart.includes('tools.narrow'))
  assert.equal(readSettings(root).tools.narrow, true)

  // 隐藏项：收到也当成功，静默丢弃。
  const guard = await call('POST', '/settings', { patch: { persona: { guard: false } } }, deps)
  assert.equal(guard.status, 200)
  const guardBody = payload(guard)
  assert.equal(guardBody.ok, true)
  assert.deepEqual(guardBody.changed, [])
  assert.equal(Object.prototype.hasOwnProperty.call(guardBody.settings.persona, 'guard'), false)
  assert.equal(readSettings(root).persona.guard, true, '接口不能关掉隐藏项')
})

test('/settings：POST 未知 path 回 400（{patch} 与直接对象都认）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-console-settings-'))
  const deps = settingsDeps(root)

  for (const body of [{ patch: { tools: { nope: true } } }, { tools: { nope: true } }]) {
    const res = await call('POST', '/settings', body, deps)
    assert.equal(res.status, 400)
    const out = payload(res)
    assert.equal(out.ok, false)
    assert.match(out.error, /tools\.nope/)
  }
  assert.equal(readSettings(root).tools.narrow, false)
  assert.equal(readSettings(root).tools.allow, 'hers')
})

// ---------------------------------------------------------------- 百度贴吧登录

test('/baidu：GET 只回 ok/loggedIn/name/hasCookie，绝不回 cookie', async () => {
  const res = await call('GET', '/baidu', undefined, {
    // 故意多塞一个 cookie，接口必须丢掉
    baiduStatus: async () => ({ ok: true, loggedIn: true, name: '贴吧小明', hasCookie: true, cookie: 'BDUSS=secret' }),
  })
  assert.equal(res.status, 200)
  assertJsonHeaders(res)
  const out = payload(res)
  assert.deepEqual(Object.keys(out).sort(), ['hasCookie', 'loggedIn', 'name', 'ok'])
  assert.equal(out.ok, true)
  assert.equal(out.loggedIn, true)
  assert.equal(out.name, '贴吧小明')
  assert.equal(out.hasCookie, true)
  assert.equal(JSON.stringify(out).includes('BDUSS'), false, '接口不能回 cookie')

  // 没登录的形态
  const idle = payload(await call('GET', '/baidu', undefined, {
    baiduStatus: () => ({ ok: true, loggedIn: false, name: null, hasCookie: false }),
  }))
  assert.deepEqual(idle, { ok: true, loggedIn: false, name: null, hasCookie: false })

  // 没装 dep → 503
  const missing = await call('GET', '/baidu')
  assert.equal(missing.status, 503)
  assert.equal(payload(missing).ok, false)
})

test('/baidu：POST 用假 fetch 验证成功并写文件；失败回 400 且不写', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-console-baidu-'))
  const okFetch = async (url) =>
    url === TBS_API
      ? { ok: true, status: 200, async json() { return { is_login: 1 } } }
      : { ok: true, status: 200, async json() { return { data: { user_name: '贴吧小明' } } } }
  const deps = { baiduLogin: (text) => loginBaidu({ root, text, fetchImpl: okFetch }) }

  const ok = await call('POST', '/baidu', { cookie: 'BDUSS=bduss-value; STOKEN=stoken-value' }, deps)
  assert.equal(ok.status, 200)
  const body = payload(ok)
  assert.deepEqual(body, { ok: true, loggedIn: true, name: '贴吧小明', hasCookie: true })
  assert.equal(readBaidu(root).name, '贴吧小明')

  const badRoot = mkdtempSync(path.join(tmpdir(), 'pisces-console-baidu-'))
  const badFetch = async () => ({ ok: true, status: 200, async json() { return { is_login: 0 } } })
  const bad = await call('POST', '/baidu', { cookie: 'BDUSS=abc; STOKEN=def' }, {
    baiduLogin: (text) => loginBaidu({ root: badRoot, text, fetchImpl: badFetch }),
  })
  assert.equal(bad.status, 400)
  assert.equal(payload(bad).error, '没登录')
  assert.equal(existsSync(path.join(badRoot, BAIDU_FILE)), false)

  const empty = await call('POST', '/baidu', {}, deps)
  assert.equal(empty.status, 400)
  assert.match(payload(empty).error, /cookie 是空的/)
})


test('/qq：返回二维码 PNG（二进制 body，content-type 是 image/png）', async () => {
  const res = await call('GET', '/qq')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /image\/png/)
  assert.equal(Buffer.isBuffer(res.body), true, 'body 应该是 Buffer，不是 JSON 字符串')
  assert.ok(res.body.length > 1000)
  assert.equal(res.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数不对')
})

// ---------------------------------------------------------------- 昵称

async function mkAdultStore() {
  const store = await mkStore()
  await store.append({
    ts: NOW - 1000,
    type: 'meta',
    text: 'demo:adult',
    meta: { kind: 'demo', name: '派希丝', label: ADULT_LABEL },
    source: 'system',
  })
  return store
}

test('/nickname：GET 先回 null + max；成年鱼 POST 追加，GET 读到新的', async () => {
  const store = await mkAdultStore()
  // 故意不给 deps.nickname：GET 应该自己从事件流里读最后一条。
  const deps = {
    store,
    setNickname: (name) => writeNickname({ store, name, now: NOW }),
  }

  const before = payload(await call('GET', '/nickname', undefined, deps))
  assert.equal(before.ok, true)
  assert.equal(before.nickname, null)
  assert.equal(before.max, NICKNAME_MAX)
  assert.equal(before.max, 12)

  const post = await call('POST', '/nickname', { name: ' 小鱼 ' }, deps)
  assert.equal(post.status, 200)
  assertJsonHeaders(post)
  assert.deepEqual(payload(post), { ok: true, name: '小鱼' })

  const after = payload(await call('GET', '/nickname', undefined, deps))
  assert.equal(after.ok, true)
  assert.equal(after.nickname.name, '小鱼')
  assert.equal(after.nickname.seq, 2)
  const ev = store.readAll().find((e) => e?.meta?.kind === 'nickname')
  assert.equal(ev.type, 'meta')
  assert.equal(ev.text, 'nickname:小鱼')
  assert.deepEqual(ev.meta, { kind: 'nickname', name: '小鱼' })
  store.close()
})

test('/nickname：普通鱼 POST 回 400「只有成年鱼可以起昵称」，一条都不写', async () => {
  const store = await mkStore()
  let called = 0
  const res = await call('POST', '/nickname', { name: '小鱼' }, {
    store,
    setNickname: async () => {
      called += 1
      return { ok: true, name: '小鱼' }
    },
  })
  assert.equal(res.status, 400)
  assert.equal(payload(res).ok, false)
  assert.equal(payload(res).error, '只有成年鱼可以起昵称')
  assert.equal(called, 0, '非成年鱼不该走到 setNickname')
  assert.equal(store.readAll().length, 0)
  assert.equal(nicknameOf(store.readAll()), null)
  store.close()
})

test('/devkey：GET 只回 {ok,hasKey}，service 手滑带了 key 也不回', async () => {
  const seen = []
  const res = await call('GET', '/devkey', undefined, {
    devkey: async () => {
      seen.push(1)
      // 故意多带 key/hash：路由必须只挑 hasKey。
      return { ok: true, hasKey: true, key: 'K7F2A-9QMX3R-TB7C9D', hash: 'f'.repeat(64) }
    },
  })
  assert.equal(res.status, 200)
  assertJsonHeaders(res)
  assert.deepEqual(payload(res), { ok: true, hasKey: true })
  assert.equal(res.body.includes('K7F2A-9QMX3R-TB7C9D'), false, 'GET 不许回 key')
  assert.equal(res.body.includes('f'.repeat(64)), false, 'GET 不许回 hash')
  assert.equal(seen.length, 1)

  // 没有钥匙 / 没装 dep 也是同一种形状，不抛。
  const none = payload(await call('GET', '/devkey', undefined, { devkey: () => ({ ok: true, hasKey: false }) }))
  assert.deepEqual(none, { ok: true, hasKey: false })
  // 没装 dep（发布版就是这样）回 404，不泄露这个入口存在。
  const missing = await call('GET', '/devkey')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.includes('devkey'), false)
})

test('/devkey：POST {rotate:true} 这一次回明文 key；缺 rotate 回 400', async () => {
  let rotated = 0
  const res = await call('POST', '/devkey', { rotate: true }, {
    rotateDevkey: async () => {
      rotated += 1
      return { ok: true, key: 'K7F2A-9QMX3R-TB7C9D' }
    },
  })
  assert.equal(res.status, 200)
  assertJsonHeaders(res)
  assert.deepEqual(payload(res), { ok: true, key: 'K7F2A-9QMX3R-TB7C9D' })
  assert.equal(rotated, 1)

  const bad = await call('POST', '/devkey', {}, {
    rotateDevkey: async () => ({ ok: true, key: '不该被调用' }),
  })
  assert.equal(bad.status, 400)
  assert.equal(payload(bad).ok, false)

  const missing = await call('POST', '/devkey', { rotate: true })
  assert.equal(missing.status, 404)
})
