// 观测台（M6）：回答"她现在是什么样"，不提供"把她改成什么样"。
//
// 三条做法（知识库 n6 / n12 / n15）：
// 1. 路由写成纯函数 `handle({method,url,body}, deps) → {status,headers,body}`：不起服务器就能测，
//    也不会因为挂载失败而测不到逻辑。任何异常都折成 JSON（500），不往外抛。
// 2. 挂载单独一层 `registerConsole`：只做 `ctx.get('webServer').register({kind:'prefix',path,handler})`，
//    没有 webServer（headless profile）返回 `{ok:false}`，不抛。
//    注意：宿主的 webServer 是 Node 风格——handler 是 `async (req, res)`，由 handler 自己
//    `res.writeHead/res.end` 回包；**不是**"返回 {status,headers,body}"的函数（否则连接会一直挂着）。
//    `handle()` 仍是纯函数；`toNodeHandler(deps)` 负责把 Node 的 req/res 折成 handle 的入参/出参。
// 3. 页面只给计数和状态，不给她的原文权重；没有性格滑条、没有数值输入。
//    唯一的输入控件是起点表单（三个偏向 radio + 一段话 textarea）和成年鱼入口 radio。
//    `/state.affinity` 是从事件流推导出来的读数（lib/affinity.js），不是她能调的分；
//    派希丝（demo）的数字还要过 reveal 遮罩：心意（tier/label/nextAt）永远给，数字聊深才给。
// 4. 成年鱼（demo）的**样本历史只在展示层过滤**：`meta.kind='demo'` 那条是基线，基线之前 90 天的
//    "最近的话/梦/核实/事件/问题/查到的"都不上墙；事件流、分流、信念、疤这些数据一条不动。
//    普通鱼没有 demo 标记 → baseline 为 null → 每个列表原样返回，行为与现在完全一致。
//
// deps 全部是 getter（宿主启动期会 dispose 再重开库，这里不能钉死实例）：
//   store / mind / nightly / dual / seed / writeSeed / adopt / home / questions / learn / verify /
//   observe / exportCard / exportSoul
// 其中 seed()/writeSeed(texts,bias)/adopt()/home()/learn({now})/verify({now}) 是 service 方法；
// questions 提供 {list,setStatus}。缺哪个，对应路由回 503 + {ok:false,error:'没装X'}。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveSelf } from './derive.js'
import { clip } from './util.js'
import { BIASES, MAX_FRAGMENTS, MAX_FRAGMENT, MAX_TOTAL, biasOf, seedOf } from './seed.js'
import { QUESTION_STATUS } from './questions.js'
import { computeAffinity, maskAffinity } from './affinity.js'
import { computeReveal, maskState } from './reveal.js'
import { isDemo } from './adopt.js'
import { NICKNAME_MAX, nicknameOf } from './nickname.js'

export const PREFIX = '/dsh-pisces-api'

/** 成年鱼（推广样本）的固定名字与起点那句话；名字不随领养者改，那句话不是名字。 */
export const ADULT_NAME = '派希丝'
export const ADULT_LABEL = '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼'

export const EVENTS_DEFAULT = 40
export const EVENTS_MAX = 200
export const DREAMS_MAX = 20
export const QUESTIONS_MAX = 200
export const STUDIES_MAX = 50

/** "最近的话"只认人说出口的、她自己的、以及做过的梦；meta/seen 这类机器事件不上墙。 */
export const RECENT_TYPES = ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer', 'dream_sim']

/** 这几个 dep 本身就是 service 方法，不能当成 getter 去调用。 */
const SERVICE_FNS = new Set(['seed', 'writeSeed', 'adopt', 'learn', 'verify', 'observe', 'exportCard', 'exportSoul'])

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }

const isThenable = (v) => v != null && typeof v.then === 'function'
const isStore = (s) => s != null && typeof s.readAll === 'function'

// ---------------------------------------------------------------------------
// 响应与 deps
// ---------------------------------------------------------------------------

function json(status, payload, extraHeaders = {}) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = JSON.stringify({ ok: false, error: '返回内容没法序列化' })
  }
  return { status, headers: { ...JSON_HEADERS, ...extraHeaders }, body }
}

const unavailable = (name) => json(503, { ok: false, error: `没装 ${name}` })
const badRequest = (error, extra = {}) => json(400, { ok: false, error, ...extra })
const badJson = () => badRequest('body 不是 JSON')
const notFound = () => json(404, { ok: false, error: '没有这个接口' })
// 开发者钥匙只给开发版：发布包里 index 不传 devkey 依赖，这里回 404 而不是 503，
// 免得外面从"没装 X"看出这个入口存在（n74）。
const devkeyGone = () => notFound()
const methodNotAllowed = (allow) => json(405, { ok: false, error: `只能 ${allow}` }, { allow })

function failure(err) {
  const why = String(err?.message || err || '未知错误')
  return json(500, { ok: false, error: `观测台内部错误：${why}` })
}

function depRaw(deps, name) {
  try {
    return deps == null ? undefined : deps[name]
  } catch {
    return undefined
  }
}

/** 读一个 dep：函数形式的 getter 调一次；service 方法原样返回（由路由自己调）。 */
function depValue(deps, name) {
  const v = depRaw(deps, name)
  if (typeof v === 'function' && !SERVICE_FNS.has(name)) {
    try {
      return v()
    } catch {
      return undefined
    }
  }
  return v
}

/** 解一层 thenable 再交给 fn；不是 Promise 就同步算。 */
function maybe(value, fn) {
  return isThenable(value) ? Promise.resolve(value).then(fn) : fn(value)
}

/** 读 body：对象原样、字符串解析 JSON；坏 JSON 返回 null。 */
function bodyOf(request) {
  const raw = request?.body
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

function parseUrl(url) {
  const text = String(url ?? '/')
  const q = text.indexOf('?')
  let pathname = (q >= 0 ? text.slice(0, q) : text) || '/'
  if (pathname === PREFIX || pathname === `${PREFIX}/`) pathname = '/'
  else if (pathname.startsWith(`${PREFIX}/`)) pathname = pathname.slice(PREFIX.length)
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  return { path: pathname, query: new URLSearchParams(q >= 0 ? text.slice(q + 1) : '') }
}

function clampLimit(raw, fallback, max) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

// ---------------------------------------------------------------------------
// demo 展示层过滤（只对成年鱼；数据本身不动）
// ---------------------------------------------------------------------------

/**
 * 成年鱼样本的基线：事件流里**最后一条** `meta.kind='demo'` 的 seq（与 reveal.js 同口径）。
 * 没有 demo 标记（普通鱼）返回 null —— 调用方据此一律不过滤。
 * @returns {{seq:number|null, ts:number}|null}
 */
function demoBaseline(events) {
  let found = null
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || String(e?.meta?.kind || '') !== 'demo') continue
    const seq = Number(e?.seq)
    found = { seq: Number.isFinite(seq) ? seq : null, ts: Number(e?.ts) || 0 }
  }
  return found
}

/** 只留基线之后的事件：有 seq 按 seq（严格大于），没有 seq 就按 ts。 */
function afterBaseline(events, baseline) {
  const list = Array.isArray(events) ? events : []
  if (!baseline) return list
  if (baseline.seq != null) return list.filter((e) => Number(e?.seq) > baseline.seq)
  return list.filter((e) => Number(e?.ts) > baseline.ts)
}

/** 一条鱼能上墙的事件：普通鱼原样；成年鱼只留领养之后的新事件。 */
function visibleEvents(events) {
  const all = Array.isArray(events) ? events : []
  const baseline = demoBaseline(all)
  return { baseline, visible: afterBaseline(all, baseline) }
}

/** "最近的话"：只认人说出口的、她自己的、以及做过的梦；最多 5 条、最新在前。 */
function recentOf(events) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => RECENT_TYPES.includes(String(e?.type)))
    .slice(-5)
    .reverse()
    .map(publicEvent)
}

const dreamCount = (events) =>
  (Array.isArray(events) ? events : []).filter(
    (e) => e?.type === 'dream_sim' && String(e?.meta?.status || '') !== 'rejected',
  ).length

const dreamRejectedCount = (events) =>
  (Array.isArray(events) ? events : []).filter(
    (e) => e?.type === 'dream_sim' && String(e?.meta?.status || '') === 'rejected',
  ).length

const verifiedCount = (events) =>
  (Array.isArray(events) ? events : []).filter((e) => String(e?.meta?.kind || '') === 'dream_observed').length

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/**
 * 观测台入口。纯函数：不发请求、不写事件；出错只回 JSON，不抛。
 * 同步路由直接回 {status,headers,body}，涉及 service 异步方法的路由回 Promise（同样永不 reject），
 * 所以调用方统一 `await handle(...)` 就行。
 */
export function handle(request, deps = {}) {
  try {
    const out = route(request, deps)
    return isThenable(out) ? out.then((r) => r, (e) => failure(e)) : out
  } catch (e) {
    return failure(e)
  }
}

function route(request, deps) {
  const method = String(request?.method || 'GET').toUpperCase()
  const { path, query } = parseUrl(request?.url)

  // 直接打开 /dsh-pisces-api 时给那页 HTML（调试用；正式形态是设置页里的面板）。
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return { status: 200, headers: { ...HTML_HEADERS }, body: page(deps) }
  }

  switch (path) {
    case '/state':
      return method === 'GET' ? stateRoute(deps) : methodNotAllowed('GET')
    case '/events':
      return method === 'GET' ? eventsRoute(deps, query) : methodNotAllowed('GET')
    case '/dreams':
      return method === 'GET' ? dreamsRoute(deps) : methodNotAllowed('GET')
    case '/questions':
      return method === 'GET' ? questionsRoute(deps) : methodNotAllowed('GET')
    case '/answer':
      return method === 'POST' ? answerRoute(deps, request) : methodNotAllowed('POST')
    case '/nightly':
      return method === 'GET' ? nightlyRoute(deps) : methodNotAllowed('GET')
    case '/nightly/run':
      return method === 'POST' ? nightlyRunRoute(deps, request) : methodNotAllowed('POST')
    case '/studies':
      return method === 'GET' ? studiesRoute(deps) : methodNotAllowed('GET')
    case '/learn':
      return method === 'POST' ? learnRoute(deps, request) : methodNotAllowed('POST')
    case '/verify':
      return method === 'POST' ? verifyRoute(deps, request) : methodNotAllowed('POST')
    case '/seed':
      if (method === 'GET') return seedRoute(deps)
      if (method === 'POST') return seedPostRoute(deps, request)
      return methodNotAllowed('GET, POST')
    case '/adopt':
      return method === 'POST' ? adoptRoute(deps, request) : methodNotAllowed('POST')
    case '/home':
      // 手动触发建家（服务晚就绪时的逃生口）：幂等，重复调不新建。
      return method === 'POST' ? homeRoute(deps) : methodNotAllowed('POST')
    case '/nickname':
      // 称呼：GET 取最后一条昵称，POST 追加一条（只有成年鱼能改）。
      if (method === 'GET') return nicknameGetRoute(deps)
      if (method === 'POST') return nicknamePostRoute(deps, request)
      return methodNotAllowed('GET, POST')
    case '/devkey':
      // 开发者钥匙：GET 只回有没有；POST 只在这一刻回明文；DELETE 删掉。
      if (method === 'GET') return devkeyGetRoute(deps)
      if (method === 'POST') return devkeyPostRoute(deps, request)
      if (method === 'DELETE') return devkeyDeleteRoute(deps)
      return methodNotAllowed('GET, POST, DELETE')
    case '/bridge':
      // 诊断：提示词桥挂没挂上（agentsSeen / sectionsAttached / agentsNotHer）。
      return method === 'GET' ? bridgeRoute(deps) : methodNotAllowed('GET')
    case '/settings':
      // 设置中心：schema 由服务端给，面板只按它渲染。
      if (method === 'GET') return settingsRoute(deps)
      if (method === 'POST') return settingsPostRoute(deps, request)
      return methodNotAllowed('GET, POST')
    case '/baidu':
      // 百度贴吧登录：GET 只回状态（绝不回 cookie），POST 粘贴 cookie 验证并落盘，DELETE 清掉。
      if (method === 'GET') return baiduStatusRoute(deps)
      if (method === 'POST') return baiduLoginRoute(deps, request)
      if (method === 'DELETE') return baiduLogoutRoute(deps)
      return methodNotAllowed('GET, POST, DELETE')
    case '/qq':
      // 反馈页的加群二维码：从包里直接读 PNG，二进制回包。
      return method === 'GET' ? qqRoute() : methodNotAllowed('GET')
    default:
      return notFound()
  }
}

// ---- /state ---------------------------------------------------------------

function stateRoute(deps) {
  const store = depValue(deps, 'store')
  const mind = depValue(deps, 'mind')
  const dual = depValue(deps, 'dual')
  // 可选：service 自己的 state()/demoInfo()。有就用它当底，缺字段再拿本模块的兜底补。
  const svc = callDep(deps, 'state')
  const demoDep = callDep(deps, 'demoInfo')
  const all = [store, mind, dual, svc, demoDep]
  if (all.some(isThenable)) {
    return Promise.all(all.map((v) => Promise.resolve(v))).then(([s, m, d, st, dm]) =>
      stateEnvelope(s, m, d, st, dm),
    )
  }
  return stateEnvelope(store, mind, dual, svc, demoDep)
}

/** 调一个可选的 service getter：函数就调一次，抛错当作没有。 */
function callDep(deps, name) {
  const v = depRaw(deps, name)
  if (typeof v !== 'function') return v
  try {
    return v()
  } catch {
    return undefined
  }
}

function stateEnvelope(store, mind, dual, svc, demoDep) {
  const own = isStore(store) ? buildState(store, mind, dual) : null
  const fromService = svc != null && typeof svc === 'object' && svc.ok !== false
  const base = fromService ? { ...(own || {}), ...svc } : own
  if (!base) return unavailable('store')
  try {
    // demo：service 的 state() 明确给了（含普通鱼的 null）就认；否则 demoInfo；最后从事件流自己判。
    // 注意 own.demo 只是本模块兜底，不能因为它非 undefined 就把 demoInfo 挡掉。
    const serviceDemo =
      fromService && Object.prototype.hasOwnProperty.call(svc, 'demo') && svc.demo !== undefined
    if (serviceDemo) {
      base.demo = svc.demo
    } else {
      const fromInfo = demoFrom(demoDep)
      base.demo = fromInfo !== undefined ? fromInfo : (own ? own.demo : null)
    }
    base.ok = true
    // 成年鱼：按领养后的交流深度盖掉还没揭开的部分（服务端遮，JSON 里不给真值）。
    // 普通鱼没有 demo，一条字段都不加、也不遮，行为与现在完全一致。
    if (base.demo) {
      let events = []
      try {
        events = isStore(store) ? store.readAll() || [] : []
      } catch {
        events = []
      }
      // 样本历史在展示层过滤：`/state` 的内容列表只看基线之后。
      // 这里要重算一遍（不能只靠 buildState），因为 service.state() 会覆盖 recent/dreams 这些字段。
      const { baseline, visible } = visibleEvents(events)
      if (baseline) {
        base.recent = recentOf(visible)
        base.dreams = dreamCount(visible)
        base.dreamsRejected = dreamRejectedCount(visible)
        base.verified = verifiedCount(visible)
      }
      const reveal = computeReveal({ events, now: Number(base.now) || Date.now() })
      // service.state() 说这是成年鱼、但事件流里还没有 demo 基线时 computeReveal 回 null：不遮。
      if (reveal) return json(200, maskState(base, reveal))
    }
    return json(200, base)
  } catch (e) {
    return failure(e)
  }
}

/** 成年鱼标记 → {name,label}|null。只认事件流里的 meta.kind='demo'，不看配置（n26）。 */
function demoOf(events) {
  const ev = (Array.isArray(events) ? events : []).find((e) => e && String(e?.meta?.kind || '') === 'demo')
  if (!ev) return null
  return {
    name: String(ev.meta?.name || ADULT_NAME),
    label: String(ev.meta?.label || ADULT_LABEL),
  }
}

/** service.demoInfo() 的形状 → {name,label} / null；认不出返回 undefined（交给下一层兜底）。 */
function demoFrom(info) {
  if (!info || typeof info !== 'object' || info.ok === false) return undefined
  if (info.name || info.label) {
    return { name: String(info.name || ADULT_NAME), label: String(info.label || ADULT_LABEL) }
  }
  if (info.demo === false) return null
  if (info.demo === true) return { name: ADULT_NAME, label: ADULT_LABEL }
  return undefined
}

/** 卡片栏的原料：天数、事件数、主导、归因计数、悬着的、梦、核实、最近 5 条、双流（只次数）。 */
export function buildState(store, mind, dual, now = Date.now()) {
  const events = store.readAll() || []
  const d = deriveSelf(events, { now })

  let desc = null
  try {
    if (mind && typeof mind.describe === 'function') desc = mind.describe()
  } catch {
    desc = null
  }

  const attribution = { d: 0, i: 0, null: 0, total: 0 }
  try {
    for (const row of store.attribAll?.() || []) {
      const label = String(row?.label ?? '')
      if (label === 'd') attribution.d += 1
      else if (label === 'i') attribution.i += 1
      else if (label === 'null') attribution.null += 1
      attribution.total += 1
    }
  } catch {
    // 归因表可丢可重建，读失败就当没有。
  }

  let openQuestions = 0
  try {
    openQuestions = (store.questionAll?.() || []).filter((q) => String(q?.status) === 'open').length
  } catch {
    openQuestions = 0
  }

  // rejected 是"没做成"的留痕，不假装是一次梦（dream.js 的口径）。
  // demo 鱼：样本历史（基线之前）一条都不上墙，只数领养之后的新内容；数据本身不动。
  const demo = demoOf(events)
  const { visible } = visibleEvents(events)
  const dreams = dreamCount(visible)
  const dreamsRejected = dreamRejectedCount(visible)
  const verified = verifiedCount(visible)
  // 拒绝/疤是面板最重的一档（成年鱼 L6 才揭开）；计数与 deriveSelf 同口径，不另算一套。
  const refusals = Array.isArray(d.refusals) ? d.refusals.length : 0
  const scars = Array.isArray(d.scars) ? d.scars.length : 0
  const recent = recentOf(visible)

  const dominance = Number(desc?.dominance)

  // 好感：每次现算，不落库、不加表。派希丝（demo）的数字过 reveal 遮罩，普通鱼不遮。
  let allQuestions = []
  try {
    allQuestions = store.questionAll?.() || []
  } catch {
    allQuestions = []
  }
  // 遮罩跟着 reveal 走（lib/reveal.js）：level >= 2 才给数字；非成年鱼 reveal 为 null → 不遮。
  const reveal = demo ? computeReveal({ events, now }) : null
  const affinity = maskAffinity(
    computeAffinity({ events, questions: allQuestions, now }),
    reveal ? reveal.level : Infinity,
  )

  return {
    ok: true,
    day: d.day,
    events: events.length,
    order: desc?.order ?? 'E=R',
    dominance: Number.isFinite(dominance) ? dominance : 0.5,
    band: desc?.band ?? null,
    splitAt: desc?.splitAt ?? null,
    attribution,
    openQuestions,
    dreams,
    dreamsRejected,
    verified,
    refusals,
    scars,
    recent,
    affinity,
    demo,
    dual: normalizeDual(dual),
    now,
  }
}

function publicEvent(e) {
  return {
    id: e?.id ?? null,
    seq: Number.isFinite(Number(e?.seq)) ? Number(e.seq) : null,
    ts: Number(e?.ts) || 0,
    day: e?.day ?? null,
    type: String(e?.type || ''),
    text: clip(e?.text ?? '', 240),
    source: e?.source ?? null,
  }
}

/** 双流：只给次数和耗时，不给约束内容、不给她的草稿（n12）。 */
function normalizeDual(dep) {
  let v = dep
  try {
    if (typeof v === 'function') v = v()
    else if (v && typeof v.stats === 'function') v = v.stats()
  } catch {
    v = null
  }
  if (v == null || typeof v !== 'object') return null
  const count = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0)
  return {
    mode: v.mode ?? null,
    plans: count(v.plans),
    cacheHits: count(v.cacheHits),
    fallbacks: count(v.fallbacks),
    seconds: Number.isFinite(Number(v.seconds)) ? Number(v.seconds) : 0,
    lastAt: Number.isFinite(Number(v.lastAt)) ? Number(v.lastAt) : null,
  }
}

// ---- /events --------------------------------------------------------------

function eventsRoute(deps, query) {
  return maybe(depValue(deps, 'store'), (store) => eventsEnvelope(store, query))
}

function eventsEnvelope(store, query) {
  if (!isStore(store)) return unavailable('store')
  try {
    const all = store.readAll() || []
    // demo 鱼：事件列表与 total 都只算领养之后（样本 90 天不上墙）；普通鱼全量。
    const { visible } = visibleEvents(all)
    const type = String(query.get('type') || '').trim()
    const limit = clampLimit(query.get('limit'), EVENTS_DEFAULT, EVENTS_MAX)
    const rows = type ? visible.filter((e) => String(e?.type) === type) : visible.slice()
    const total = rows.length
    const picked = rows.slice(-limit).reverse()
    return json(200, { ok: true, count: picked.length, total, limit, type: type || null, events: picked.map(publicEvent) })
  } catch (e) {
    return failure(e)
  }
}

// ---- /dreams --------------------------------------------------------------

function dreamsRoute(deps) {
  return maybe(depValue(deps, 'store'), dreamsEnvelope)
}

function dreamsEnvelope(store) {
  if (!isStore(store)) return unavailable('store')
  try {
    const all = store.readAll() || []
    // demo 鱼：做过的梦与"核实"都只看领养之后；样本里的梦不显示。
    const { visible } = visibleEvents(all)
    const observed = new Set(
      visible.filter((e) => String(e?.meta?.kind || '') === 'dream_observed').map((e) => String(e?.meta?.dream || '')),
    )
    const dreams = visible
      .filter((e) => e?.type === 'dream_sim')
      .slice(-DREAMS_MAX)
      .reverse()
      .map((e) => {
        const meta = e.meta || {}
        const status = String(meta.status || 'untested')
        return {
          id: e.id ?? null,
          ts: Number(e.ts) || 0,
          day: e.day ?? null,
          status,
          rejected: status === 'rejected' ? (Array.isArray(meta.rejected) ? meta.rejected.map(String) : []) : null,
          thread: String(meta.thread || ''),
          hypothesis: String(meta.hypothesis || ''),
          test: String(meta.test || ''),
          text: clip(e.text ?? '', 400),
          verified: observed.has(String(e.id || '')),
        }
      })
    return json(200, { ok: true, count: dreams.length, dreams })
  } catch (e) {
    return failure(e)
  }
}

// ---- /questions -----------------------------------------------------------

function questionsRoute(deps) {
  return maybe(depValue(deps, 'store'), (store) =>
    maybe(depValue(deps, 'questions'), (qs) => questionsEnvelope(qs, store)),
  )
}

function questionsEnvelope(qs, store) {
  if (!qs || typeof qs.list !== 'function') return unavailable('questions')
  let rows
  try {
    rows = qs.list({ status: 'all', limit: QUESTIONS_MAX })
  } catch (e) {
    return failure(e)
  }
  return maybe(rows, (x) => normalizeQuestions(x, store))
}

/** 这条问题是不是领养后才有的：refs 里的事件 seq 优先；判不了再比 createdAt/at 与基线 ts。 */
function questionAfterBaseline(q, baseline, seqById, tsById) {
  const refs = Array.isArray(q?.refs) ? q.refs : []
  let judged = false
  let newer = false
  for (const ref of refs) {
    const id = String(ref)
    if (baseline.seq != null) {
      const seq = seqById.get(id)
      if (!Number.isFinite(seq)) continue
      judged = true
      if (seq > baseline.seq) newer = true
    } else {
      const ts = tsById.get(id)
      if (!Number.isFinite(ts)) continue
      judged = true
      if (ts > baseline.ts) newer = true
    }
  }
  if (judged) return newer
  // 没有能判的 ref（空 refs / 引的事件不在流里）：按创建时间与基线比。
  const at = Number(q?.at ?? q?.createdAt)
  if (Number.isFinite(at) && at > 0) return at > baseline.ts
  const since = Number(q?.since)
  if (Number.isFinite(since) && since > 0) return since > baseline.ts
  // 什么时间都没有就不藏着：宁可多显示一条，也不误删领养后的问题。
  return true
}

function normalizeQuestions(rows, store) {
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.questions) ? rows.questions : []
  let events = []
  try {
    events = isStore(store) ? store.readAll() || [] : []
  } catch {
    events = []
  }
  const baseline = demoBaseline(events)
  // demo 鱼：样本历史里带出来的问题不显示（只过滤，不改库里的 questions 表）。
  const visible = baseline
    ? (() => {
        const seqById = new Map()
        const tsById = new Map()
        for (const e of events) {
          if (!e || e.id == null) continue
          const id = String(e.id)
          seqById.set(id, Number(e.seq))
          tsById.set(id, Number(e.ts) || 0)
        }
        return list.filter((q) => questionAfterBaseline(q, baseline, seqById, tsById))
      })()
    : list
  const out = visible
    .filter((q) => q && q.key)
    .map((q) => ({
      key: String(q.key),
      kind: String(q.kind || ''),
      text: String(q.text || ''),
      status: String(q.status || 'open'),
      since: Number(q.since) || 0,
      refs: Array.isArray(q.refs) ? q.refs.map(String) : [],
      source: String(q.source || ''),
    }))
  out.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
  return json(200, { ok: true, count: out.length, questions: out })
}

// ---- /answer --------------------------------------------------------------

function answerRoute(deps, request) {
  return maybe(depValue(deps, 'questions'), (qs) => answerEnvelope(qs, request))
}

function answerEnvelope(qs, request) {
  if (!qs || typeof qs.setStatus !== 'function') return unavailable('questions')
  const body = bodyOf(request)
  if (body === null) return badJson()
  const key = String(body.key ?? '').trim()
  const status = String(body.status ?? '').trim()
  if (!QUESTION_STATUS.includes(status)) return badRequest(`状态只能是 ${QUESTION_STATUS.join(' / ')}`)
  if (!key) return badRequest('没有这条问题')
  let r
  try {
    r = qs.setStatus(key, status)
  } catch (e) {
    return failure(e)
  }
  return maybe(r, (x) => answerResult(x, key, status))
}

function answerResult(r, key, status) {
  if (r === false) return badRequest('没有这条问题', { key })
  if (r && typeof r === 'object' && r.ok === false) {
    return json(400, { ok: false, error: String(r.reason || '改不了这条问题'), key, status })
  }
  return json(200, { ok: true, key, status })
}

// ---- /nightly -------------------------------------------------------------

function nightlyRoute(deps) {
  return maybe(depValue(deps, 'nightly'), nightlyEnvelope)
}

function nightlyEnvelope(nightly) {
  if (!nightly || typeof nightly.due !== 'function') return unavailable('nightly')
  const now = Date.now()
  let due
  try {
    due = nightly.due({ now })
  } catch (e) {
    due = { ok: false, reason: String(e?.message || e) }
  }
  let last = null
  try {
    last = typeof nightly.last === 'function' ? nightly.last() : (nightly.last ?? null)
  } catch {
    last = null
  }
  const lastNum = Number(last)
  return maybe(due, (d) =>
    json(200, { ok: true, now, due: d ?? null, last: Number.isFinite(lastNum) ? lastNum : null }),
  )
}

function nightlyRunRoute(deps, request) {
  return maybe(depValue(deps, 'nightly'), (n) => nightlyRunEnvelope(n, request))
}

function nightlyRunEnvelope(nightly, request) {
  if (!nightly || typeof nightly.run !== 'function') return unavailable('nightly')
  const body = bodyOf(request)
  if (body === null) return badJson()
  const force = Boolean(body.force)
  const dryRun = Boolean(body.dryRun)
  let r
  try {
    r = nightly.run({ force, dryRun })
  } catch (e) {
    return failure(e)
  }
  return maybe(r, (x) => json(200, { ok: true, ran: x?.ran === true, run: x ?? null }))
}

// ---- /studies -------------------------------------------------------------

function studiesRoute(deps) {
  return maybe(depValue(deps, 'store'), studiesEnvelope)
}

function studiesEnvelope(store) {
  if (!isStore(store)) return unavailable('store')
  try {
    const rows = store.studiesAll?.() || []
    // demo 鱼：样本历史里查到的（at 早于基线）不显示；at 读不出来就不藏。
    let baseline = null
    try {
      baseline = demoBaseline(store.readAll() || [])
    } catch {
      baseline = null
    }
    const visibleRows = baseline
      ? rows.filter((r) => !(Number(r?.at) > 0 && Number(r.at) < baseline.ts))
      : rows
    const sorted = visibleRows.slice().sort((a, b) => Number(b.at) - Number(a.at) || String(a.key).localeCompare(String(b.key)))
    const studies = sorted.slice(0, STUDIES_MAX).map((r) => ({
      key: String(r.key || ''),
      question: String(r.question || ''),
      facts: Array.isArray(r.facts) ? r.facts.map(String) : [],
      sources: Array.isArray(r.sources) ? r.sources : [],
      at: Number(r.at) || 0,
    }))
    return json(200, { ok: true, count: studies.length, total: visibleRows.length, studies })
  } catch (e) {
    return failure(e)
  }
}

// ---- /learn, /verify ------------------------------------------------------

function learnRoute(deps, request) {
  return serviceAction(depRaw(deps, 'learn'), request, 'learn')
}

function verifyRoute(deps, request) {
  return serviceAction(depRaw(deps, 'verify'), request, 'verify')
}

/** learn/verify 同形：service 方法，入参 {now}（body 里可以带），回 {ok:true,result}。 */
function serviceAction(fn, request, name) {
  if (typeof fn !== 'function') return unavailable(name)
  const body = bodyOf(request)
  if (body === null) return badJson()
  const want = Number(body.now)
  const now = Number.isFinite(want) && want > 0 ? want : Date.now()
  let r
  try {
    r = fn({ now })
  } catch (e) {
    return failure(e)
  }
  return maybe(r, (x) => json(200, { ok: true, now, result: x ?? null }))
}

// ---- /seed ----------------------------------------------------------------

function seedRoute(deps) {
  const store = depValue(deps, 'store')
  const seedFn = depRaw(deps, 'seed')
  if (isThenable(store)) return Promise.resolve(store).then((s) => seedEnvelope(s, seedFn))
  return seedEnvelope(store, seedFn)
}

function seedEnvelope(store, seedFn) {
  try {
    if (isStore(store)) return json(200, seedView(store))
    if (typeof seedFn === 'function') {
      let r
      try {
        r = seedFn()
      } catch (e) {
        return failure(e)
      }
      return maybe(r, (x) => json(200, normalizeSeedView(x)))
    }
    return unavailable('seed')
  } catch (e) {
    return failure(e)
  }
}

function seedView(store) {
  const events = store.readAll() || []
  const ev = seedOf(events)
  const fragments = ev
    ? Array.isArray(ev.meta?.fragments)
      ? ev.meta.fragments.map(String)
      : String(ev.text ?? '')
          .split(/\n{2,}/)
          .filter(Boolean)
    : []
  const current = ev
    ? {
        text: String(ev.text ?? ''),
        fragments,
        chars: Number(ev.meta?.chars) || fragments.join('').length,
        bias: ev.meta?.bias ? String(ev.meta.bias) : null,
        biasName: biasName(ev.meta?.bias),
        at: Number(ev.ts) || null,
        day: ev.day ?? null,
        source: ev.source ?? null,
      }
    : null
  return {
    ok: true,
    hasSeed: !!ev,
    canWrite: !ev,
    current,
    biases: BIASES.map((b) => ({ id: b.id, name: b.name, hint: b.hint })),
    limits: { fragments: MAX_FRAGMENTS, fragment: MAX_FRAGMENT, total: MAX_TOTAL },
    adult: { name: ADULT_NAME, label: ADULT_LABEL, available: !ev },
  }
}

/** service 自己给了起点状态时用它的形状；缺字段用本模块的口径补上。 */
function normalizeSeedView(v) {
  const src = v && typeof v === 'object' ? v : {}
  const current = src.current && typeof src.current === 'object' ? src.current : null
  const hasSeed = src.hasSeed === true || current != null
  return {
    ok: true,
    hasSeed,
    canWrite: src.canWrite === true || !hasSeed,
    current,
    biases: Array.isArray(src.biases) && src.biases.length ? src.biases : BIASES.map((b) => ({ id: b.id, name: b.name, hint: b.hint })),
    limits: src.limits || { fragments: MAX_FRAGMENTS, fragment: MAX_FRAGMENT, total: MAX_TOTAL },
    adult: { name: ADULT_NAME, label: ADULT_LABEL, available: !hasSeed },
  }
}

function biasName(id) {
  const b = biasOf(id)
  return b ? b.name : null
}

function seedPostRoute(deps, request) {
  const fn = depRaw(deps, 'writeSeed')
  if (typeof fn !== 'function') return unavailable('writeSeed')
  const body = bodyOf(request)
  if (body === null) return badJson()
  const texts = seedTexts(body)
  const bias = body.bias == null ? 'balanced' : String(body.bias)
  let r
  try {
    r = fn(texts, bias)
  } catch (e) {
    return failure(e)
  }
  return maybe(r, seedPostResult)
}

function seedTexts(body) {
  if (Array.isArray(body.texts)) return body.texts.map((t) => String(t ?? ''))
  if (typeof body.text === 'string') return body.text.split(/\n\s*\n/)
  return []
}

function seedPostResult(r) {
  if (r && typeof r === 'object' && r.ok === false) {
    return json(400, {
      ok: false,
      error: String(r.reason || '起点写不进去'),
      problems: Array.isArray(r.problems) ? r.problems.map(String) : [],
    })
  }
  return json(200, {
    ok: true,
    eventId: r?.event?.id ?? null,
    fragments: Array.isArray(r?.fragments) ? r.fragments : [],
    chars: Number(r?.chars) || 0,
  })
}

// ---- /adopt ---------------------------------------------------------------

function adoptRoute(deps, request) {
  const fn = depRaw(deps, 'adopt')
  if (typeof fn !== 'function') return unavailable('adopt')
  const body = bodyOf(request)
  if (body === null) return badJson()
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, adoptResult)
}

function adoptResult(r) {
  if (r && typeof r === 'object' && r.ok === false) {
    return json(400, { ok: false, error: String(r.reason || '领养没成') })
  }
  return json(200, { ok: true, name: ADULT_NAME, result: r ?? null })
}

// ---- /home ----------------------------------------------------------------

/**
 * 手动建家。`deps.home()` 是 index 的 `service.home`（幂等，失败回 `{ok:false,reason}`）。
 * 没装就 503；宿主服务缺失（可重试）也照实回 400 + reason，不在这里等——
 * 重试窗口由 `ensureHomeWithRetry` 在 service 里走完。
 */
function homeRoute(deps) {
  const fn = depRaw(deps, 'home')
  if (typeof fn !== 'function') return unavailable('home')
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, homeResult)
}

function homeResult(r) {
  if (r && typeof r === 'object' && r.ok === false) {
    return json(400, {
      ok: false,
      error: String(r.reason || '家没建好'),
      ...(r.retryable === true ? { retryable: true } : {}),
    })
  }
  const out = r && typeof r === 'object' ? r : {}
  return json(200, { ...out, ok: true })
}

// ---- /nickname ------------------------------------------------------------

/** GET /nickname：service.nickname() 优先；没有这个 dep 就直接读事件流最后一条。 */
function nicknameGetRoute(deps) {
  const fromService = callDep(deps, 'nickname')
  const store = depValue(deps, 'store')
  if (isThenable(fromService) || isThenable(store)) {
    return Promise.all([Promise.resolve(fromService), Promise.resolve(store)]).then(([r, s]) =>
      nicknameEnvelope(r, s),
    )
  }
  return nicknameEnvelope(fromService, store)
}

function nicknameEnvelope(fromService, store) {
  let nickname = null
  const serviceSays = fromService && typeof fromService === 'object' && fromService.ok !== false
  if (serviceSays && fromService.nickname !== undefined) {
    nickname = fromService.nickname
  } else {
    try {
      nickname = nicknameOf(isStore(store) ? store.readAll() || [] : [])
    } catch {
      nickname = null
    }
  }
  return json(200, { ok: true, nickname: nickname ?? null, max: NICKNAME_MAX })
}

/** POST /nickname {name}：非成年鱼直接拒；名字的校验与追加交给 setNickname。 */
function nicknamePostRoute(deps, request) {
  return maybe(depValue(deps, 'store'), (store) => nicknamePostEnvelope(deps, request, store))
}

function nicknamePostEnvelope(deps, request, store) {
  const body = bodyOf(request)
  if (body === null) return badJson()
  // 只有成年鱼能起昵称：判据只看事件流（n26），和工具面/面板一致。
  let adult = false
  try {
    adult = isDemo(isStore(store) ? store.readAll() || [] : [])
  } catch {
    adult = false
  }
  if (!adult) return json(400, { ok: false, error: '只有成年鱼可以起昵称' })

  const fn = depRaw(deps, 'setNickname')
  if (typeof fn !== 'function') return unavailable('setNickname')
  let r
  try {
    r = fn(body.name)
  } catch (e) {
    return failure(e)
  }
  return maybe(r, nicknameSetResult)
}

function nicknameSetResult(r) {
  if (r && typeof r === 'object' && r.ok === false) {
    return json(400, { ok: false, error: String(r.reason || '没改') })
  }
  const name = r && typeof r === 'object' ? r.name : null
  return json(200, { ok: true, name: name ?? null })
}

// ---- /devkey --------------------------------------------------------------

/** GET：只回 `{ok, hasKey}`；就算 service 手滑带了 key/hash 也在这里丢掉。 */
function devkeyGetRoute(deps) {
  const fn = depRaw(deps, 'devkey')
  if (typeof fn !== 'function') return devkeyGone()
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, (x) => {
    if (x && typeof x === 'object' && x.ok === false) return devkeyGone()
    return json(200, { ok: true, hasKey: x?.hasKey === true })
  })
}

/** POST {rotate:true}：生成新的并返回明文——只有这一次。 */
function devkeyPostRoute(deps, request) {
  const fn = depRaw(deps, 'rotateDevkey')
  if (typeof fn !== 'function') return devkeyGone()
  const body = bodyOf(request)
  if (body === null) return badJson()
  if (body.rotate !== true) return badRequest('要 rotate:true')
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, (x) => {
    if (!x || typeof x !== 'object' || x.ok === false) {
      return json(400, { ok: false, error: String(x?.reason || '没生成') })
    }
    if (typeof x.key !== 'string' || !x.key) return failure(new Error('没拿到钥匙'))
    return json(200, { ok: true, key: x.key })
  })
}

/** DELETE：删掉 devkey.json；不返回 key。 */
function devkeyDeleteRoute(deps) {
  const fn = depRaw(deps, 'deleteDevkey')
  if (typeof fn !== 'function') return devkeyGone()
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, () => json(200, { ok: true, hasKey: false }))
}

function bridgeRoute(deps) {
  const fn = depRaw(deps, 'bridge')
  if (typeof fn !== 'function') return unavailable('bridge')
  let info = null
  try {
    info = fn()
  } catch {
    info = null
  }
  if (!info || typeof info !== 'object') return unavailable('bridge')
  // 只回白名单字段：次数/状态，不含段正文。
  const pick = (k) => (k in info ? info[k] : undefined)
  // 语音回复状态：没有适配器时 available:false；这条只给桥/诊断看，页面不渲染。
  const v = depValue(deps, 'voice')
  const bridge = {
    enabled: pick('enabled'),
    storeReady: pick('storeReady'),
    agentsSeen: pick('agentsSeen'),
    sectionsAttached: pick('sectionsAttached'),
    agentsSkipped: pick('agentsSkipped'),
    agentsNotHer: pick('agentsNotHer'),
    guardHits: pick('guardHits'),
    devHits: pick('devHits'),
    stream: pick('stream'),
    // 聊天落库诊断：只给次数/形状，不给正文。
    // { streamsWrapped, chunksSeen, textParts, utterancesWritten, lastChunkShape }
    streamDebug: pick('streamDebug'),
    voice: { available: v?.available === true, kind: v?.kind ?? null },
  }
  return json(200, { ok: true, bridge })
}

// ---- /settings ------------------------------------------------------------

function settingsRoute(deps) {
  return maybe(callDep(deps, 'settings'), settingsEnvelope)
}

function settingsEnvelope(r) {
  if (!r || typeof r !== 'object') return unavailable('settings')
  const out = { ok: r.ok !== false, settings: r.settings ?? {}, schema: Array.isArray(r.schema) ? r.schema : [] }
  if (r.root != null) out.root = String(r.root)
  return json(200, out)
}

function settingsPostRoute(deps, request) {
  const fn = depRaw(deps, 'saveSettings')
  if (typeof fn !== 'function') return unavailable('saveSettings')
  const body = bodyOf(request)
  if (body === null) return badJson()
  // 面板发 {patch:{...}}；也接受直接一个对象（curl 手测方便）。
  const patch = body && body.patch !== undefined ? body.patch : body
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return badRequest('patch 要是一个对象')
  let r
  try {
    r = fn(patch)
  } catch (e) {
    return failure(e)
  }
  return maybe(r, settingsResult)
}

function settingsResult(r) {
  if (r && typeof r === 'object' && r.ok === false) {
    const problems = Array.isArray(r.problems) ? r.problems : []
    return json(400, { ok: false, error: String(r.reason || problems[0] || '设置没写进去'), problems })
  }
  const x = r && typeof r === 'object' ? r : {}
  return json(200, {
    ok: true,
    settings: x.settings ?? {},
    changed: Array.isArray(x.changed) ? x.changed : [],
    needsRestart: Array.isArray(x.needsRestart) ? x.needsRestart : [],
    ...(x.ignored ? { ignored: x.ignored } : {}),
    ...(x.note ? { note: x.note } : {}),
  })
}

// ---- /baidu ---------------------------------------------------------------

/** GET：只回登录状态，**绝不回 cookie**（值在落盘文件里，接口不给看）。 */
function baiduStatusRoute(deps) {
  return maybe(callDep(deps, 'baiduStatus'), baiduEnvelope)
}

function baiduEnvelope(r) {
  if (!r || typeof r !== 'object') return unavailable('baiduStatus')
  return json(200, {
    ok: true,
    loggedIn: r.loggedIn === true,
    name: r.name == null || r.name === '' ? null : String(r.name),
    hasCookie: r.hasCookie === true,
  })
}

/** POST {cookie}：粘贴 → 验证 → 落盘；失败回 400 + 后端 reason。 */
function baiduLoginRoute(deps, request) {
  const fn = depRaw(deps, 'baiduLogin')
  if (typeof fn !== 'function') return unavailable('baiduLogin')
  const body = bodyOf(request)
  if (body === null) return badJson()
  const text = typeof body.cookie === 'string' ? body.cookie : ''
  if (!text.trim()) return badRequest('cookie 是空的')
  let r
  try {
    r = fn(text)
  } catch (e) {
    return failure(e)
  }
  return maybe(r, baiduLoginResult)
}

function baiduLoginResult(r) {
  if (!r || typeof r !== 'object' || r.ok === false) {
    return json(400, { ok: false, error: String(r?.reason || '没登上') })
  }
  return json(200, {
    ok: true,
    loggedIn: true,
    name: r.name == null || r.name === '' ? null : String(r.name),
    hasCookie: true,
  })
}

/** DELETE：清掉本地登录文件（可选入口，面板不做按钮）。 */
function baiduLogoutRoute(deps) {
  const fn = depRaw(deps, 'baiduLogout')
  if (typeof fn !== 'function') return unavailable('baiduLogout')
  let r
  try {
    r = fn()
  } catch (e) {
    return failure(e)
  }
  return maybe(r, () => json(200, { ok: true, loggedIn: false, name: null, hasCookie: false }))
}

// ---- /qq ------------------------------------------------------------------

/** 二维码文件随包走；路径从本文件算，不依赖宿主 cwd。 */
const QQ_FILE = join(import.meta.dirname, '..', 'assets', 'qq-group.png')

function qqRoute() {
  try {
    const body = readFileSync(QQ_FILE)
    if (!body || !body.length) return json(404, { ok: false, error: '二维码图片没找到' })
    return {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': String(body.length),
      },
      body,
    }
  } catch {
    return json(404, { ok: false, error: '二维码图片没找到' })
  }
}

// ---------------------------------------------------------------------------
// 挂载（n6 / n47：单独一层，没有 webServer 就返回 {ok:false}）
// ---------------------------------------------------------------------------

/** 能 JSON.parse 就解析，失败当字符串；空 body / 没有 body → undefined。 */
function tryJson(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * 读 Node 请求体：POST/PUT/PATCH 时由 toNodeHandler 调用。
 * 不存在 body 时返回 undefined；优先用已经挂好的 `req.body`（有的宿主会预读）。
 */
export function readBody(req) {
  if (req == null) return Promise.resolve(undefined)
  if (req.body !== undefined && req.body !== null) {
    return Promise.resolve(typeof req.body === 'string' ? tryJson(req.body) : req.body)
  }
  if (typeof req.on !== 'function') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      req.on('data', (chunk) => {
        if (chunk == null) return
        data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      })
      req.on('end', () => finish(tryJson(data)))
      req.on('error', () => finish(undefined))
    } catch {
      finish(undefined)
    }
  })
}

/** 把 handle 的 {status,headers,body} 写进 Node 响应；对象 body 自动 JSON.stringify。 */
function writeNode(res, out) {
  const result = out && typeof out === 'object' ? out : { status: 200, headers: {}, body: out }
  const status = Number.isFinite(Number(result.status)) ? Number(result.status) : 200
  const headers = { ...(result.headers && typeof result.headers === 'object' ? result.headers : {}) }
  let body = result.body
  if (body == null) body = ''
  else if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
    // PNG 这类二进制：原样交给 res.end，绝不 JSON.stringify。
    body = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  } else if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    try {
      body = JSON.stringify(body)
    } catch {
      body = JSON.stringify({ ok: false, error: '返回内容没法序列化' })
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json; charset=utf-8'
    }
  }
  try {
    if (typeof res?.writeHead === 'function') res.writeHead(status, headers)
    else if (res && typeof res.setHeader === 'function') {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
      if ('statusCode' in res) res.statusCode = status
    }
  } catch {
    // 头写不进去也继续 end：宁可少一个 header，也不能让连接挂着。
  }
  try {
    if (typeof res?.end === 'function') res.end(body)
  } catch {
    // 已经断开就算了。
  }
}

/**
 * Node 风格的 handler：`async (req, res)`，自己回包。
 * 这是 webServer.register 真正要的形状（n6 的假 webServer 起真 HTTP 时也这么挂）。
 */
export function toNodeHandler(deps = {}) {
  return async function handler(req, res) {
    try {
      const method = String(req?.method || 'GET').toUpperCase()
      const url = String(req?.url || '/')
      let body
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') body = await readBody(req)
      const out = await handle({ method, url, body }, deps)
      writeNode(res, out)
    } catch (e) {
      writeNode(res, {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        body: { ok: false, error: String(e?.message || e) },
      })
    }
  }
}

/**
 * 把观测台挂到宿主的 webServer 上。
 * @returns {{ok:boolean, route?:object, dispose?:Function, reason?:string}}
 */
export function registerConsole(ctx, deps = {}) {
  let server = null
  try {
    if (ctx && typeof ctx.get === 'function') server = ctx.get('webServer')
    if (!server && ctx && ctx.webServer) server = ctx.webServer
  } catch {
    server = null
  }
  const register = server && typeof server.register === 'function' ? server.register : null
  if (!register) return { ok: false, reason: '没有 webServer，观测台没挂上（headless profile 正常）' }

  const route = {
    kind: 'prefix',
    path: PREFIX,
    handler: toNodeHandler(deps),
  }
  try {
    const off = register.call(server, route)
    let dispose = () => {}
    if (typeof off === 'function') dispose = off
    else if (off && typeof off.dispose === 'function') dispose = () => off.dispose()
    return { ok: true, route, dispose }
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) }
  }
}

// ---------------------------------------------------------------------------
// 一页 HTML：自带脚本、不依赖构建
// ---------------------------------------------------------------------------

/**
 * 观测台的一页 HTML。没有性格滑条、没有好感度、没有数值输入。
 * 注意 n15：模板里的 `\n`/`\s` 在反引号里会变成真字符，脚本里的正则必须写成 `\\n`/`\\s`，
 * 否则整段 <script> 语法错误、页面一片空白。
 */
export function page(deps = {}) {
  void deps
  const biasRadios = BIASES.map(
    (b, i) =>
      `<label class="bias"><input type="radio" name="bias" value="${b.id}"${i === 0 ? ' checked' : ''}> <b>${b.name}</b><em>${b.hint}</em></label>`,
  ).join('\n      ')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鱼肥生双 · 观测台</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #14161a; color: #e6e9ef; font: 14px/1.6 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 40px; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  h2 { font-size: 14px; margin: 0 0 10px; color: #aab3c2; font-weight: 600; }
  .hint { color: #8b95a5; font-size: 12px; margin: 4px 0; }
  .red { color: #ff7b72; font-size: 13px; margin: 6px 0; }
  .note { color: #8b95a5; font-size: 12px; margin-left: 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 8px; margin: 18px 0; }
  .card { background: #1c2027; border: 1px solid #2a3039; border-radius: 8px; padding: 8px 10px; }
  .card .k { display: block; color: #8b95a5; font-size: 12px; }
  .card b { font-size: 18px; font-weight: 600; }
  .card .u { color: #8b95a5; font-size: 12px; margin-left: 2px; }
  .panel, .col { background: #1c2027; border: 1px solid #2a3039; border-radius: 10px; padding: 14px; }
  .panel { margin: 14px 0; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; margin: 14px 0; }
  .biases { display: grid; gap: 6px; margin: 8px 0; }
  .bias { display: block; color: #cfd6e2; font-size: 13px; }
  .bias em { color: #8b95a5; font-style: normal; font-size: 12px; margin-left: 6px; }
  textarea { width: 100%; margin: 8px 0; background: #101318; color: #e6e9ef; border: 1px solid #2a3039; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  button { background: #2a3039; color: #e6e9ef; border: 1px solid #3a424e; border-radius: 7px; padding: 6px 12px; font: inherit; cursor: pointer; }
  button:hover { background: #343b46; }
  .adult-entry { border-top: 1px dashed #2a3039; margin-top: 12px; padding-top: 10px; }
  .adult-entry > label { color: #cfd6e2; }
  #adultBox { margin: 8px 0 0 22px; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { padding: 6px 0; border-bottom: 1px solid #232830; font-size: 13px; }
  li:last-child { border-bottom: 0; }
  li em { display: block; color: #8b95a5; font-size: 11px; font-style: normal; }
  li.empty { color: #6f7887; }
  li.dim { opacity: .72; }
  .tag { display: inline-block; background: #262c35; color: #9fb0c8; border-radius: 4px; padding: 0 5px; font-size: 11px; margin-right: 4px; }
  .tag.warn { color: #ffb86b; }
  .tag.ok { color: #7ee787; }
  .fact { display: block; color: #b9c3d3; font-size: 12px; }
  #seedCurrentText p { margin: 4px 0; }
  footer { margin-top: 22px; color: #6f7887; font-size: 12px; border-top: 1px solid #232830; padding-top: 10px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>鱼肥生双 · 观测台</h1>
    <p class="hint">只读：这里只回答"她现在是什么样"，不提供"把她改成什么样"。</p>
  </header>

  <section class="cards">
    <div class="card"><span class="k">存在</span><b id="cDay">—</b><span class="u">天</span></div>
    <div class="card"><span class="k">事件</span><b id="cEvents">—</b></div>
    <div class="card"><span class="k">归因</span><b id="cAttrib">—</b></div>
    <div class="card"><span class="k">主导</span><b id="cOrder">—</b></div>
    <div class="card"><span class="k">悬着</span><b id="cOpen">—</b></div>
    <div class="card"><span class="k">梦</span><b id="cDreams">—</b></div>
    <div class="card"><span class="k">核实</span><b id="cVerified">—</b></div>
    <div class="card"><span class="k">上次整理</span><b id="cNightly">—</b></div>
  </section>
  <p class="hint" id="dualLine">双流没开</p>

  <section class="panel" id="seedPanel">
    <h2>起点</h2>
    <p class="hint" id="seedLimit">最多 ${MAX_FRAGMENTS} 段、每段不超过 ${MAX_FRAGMENT} 字、合计不超过 ${MAX_TOTAL} 字；写完就定下来，不能改。</p>
    <div id="seedForm">
      <p class="red">养鱼新手不要调整，默认就行</p>
      <div class="biases">
      ${biasRadios}
      </div>
      <textarea id="seedText" rows="6" placeholder="她是谁、从哪儿开始。想分段就空一行。"></textarea>
      <div class="row"><button id="seedWrite">写下去</button><span id="seedNote" class="note"></span></div>
      <div class="adult-entry">
        <label><input type="radio" name="startMode" id="startMode" value="adult"> ${ADULT_LABEL}</label>
        <div id="adultBox" hidden>
          <p>她叫：<b>${ADULT_NAME}</b></p>
          <p class="hint">领养一条活过 90 天的样本。那句话是她的起点，不是她的名字；领养之后照常长大。</p>
          <div class="row"><button id="adoptBtn">领养这条成年鱼</button><span id="adoptNote" class="note"></span></div>
        </div>
      </div>
    </div>
    <div id="seedCurrent" hidden>
      <p class="hint">已经写过，不能再改。</p>
      <div id="seedCurrentText"></div>
    </div>
  </section>

  <section class="cols">
    <div class="col"><h2>她最近说的话</h2><ul id="recent"></ul></div>
    <div class="col"><h2>悬着的事</h2><ul id="questions"></ul></div>
    <div class="col"><h2>做过的梦</h2><ul id="dreams"></ul>
      <div class="row"><button id="verifyBtn">核对一下梦里的假设</button></div>
    </div>
    <div class="col"><h2>她查到的</h2><ul id="studies"></ul>
      <div class="row"><button id="learnBtn">查一次</button></div>
    </div>
  </section>

  <section class="row"><button id="nightlyBtn">现在整理一次</button><span id="nightlyNote" class="note"></span></section>

  <footer>只读面板：没有改人格、改记忆、编辑事件的入口</footer>
</main>
<script>
(function () {
  var API = '${PREFIX}'

  function $(id) { return document.getElementById(id) }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
      return map[ch]
    })
  }
  function get(path) {
    return fetch(API + path, { headers: { accept: 'application/json' } }).then(function (r) { return r.json() })
  }
  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json() })
  }
  function pad(n) { return (n < 10 ? '0' : '') + n }
  function when(ts) {
    var d = new Date(Number(ts) || 0)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }
  function age(ms) {
    if (ms == null || !isFinite(Number(ms))) return '还没整理过'
    var d = Date.now() - Number(ms)
    if (d < 60000) return '刚刚'
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
    return when(ms).slice(0, 10)
  }
  var ORDERS = { 'E=R': '两边都听', 'R>E': '先算一遍', 'E>R': '先凭感觉', 'single': '一条线', 'none': '一条线' }
  function orderText(o) { return ORDERS[o] || (o ? String(o) : '一条线') }
  var STATUS = { open: '悬着', answered: '答过', dropped: '放下', observed: '留意过' }

  function renderState(s) {
    if (!s || !s.ok) return
    $('cDay').textContent = s.day == null ? '—' : s.day
    $('cEvents').textContent = s.events == null ? '—' : s.events
    var a = s.attribution || {}
    $('cAttrib').textContent = 'd ' + (a.d || 0) + ' · i ' + (a.i || 0) + ' · 空 ' + (a.null || 0)
    $('cOrder').textContent = orderText(s.order)
    $('cOrder').title = '主导 ' + (s.dominance == null ? '—' : Number(s.dominance).toFixed(2))
    $('cOpen').textContent = s.openQuestions == null ? '—' : s.openQuestions
    $('cDreams').textContent = s.dreams == null ? '—' : s.dreams
    $('cVerified').textContent = s.verified == null ? '—' : s.verified
    renderRecent(s.recent || [])
    var dual = s.dual
    if (!dual) {
      $('dualLine').textContent = '双流没开'
    } else {
      var line = '双流 ' + (dual.mode || '—') + ' · 先算 ' + dual.plans + ' 次 · 命中缓存 ' + dual.cacheHits + ' 次 · 退回 ' + dual.fallbacks + ' 次'
      if (dual.lastAt) line += ' · 最近 ' + when(dual.lastAt)
      $('dualLine').textContent = line
    }
  }

  function renderRecent(rows) {
    $('recent').innerHTML = rows.length
      ? rows.map(function (e) {
          return '<li><span class="tag">' + esc(e.type) + '</span>' + esc(e.text) + '<em>' + esc(when(e.ts)) + '</em></li>'
        }).join('')
      : '<li class="empty">还没有她的话。</li>'
  }

  function renderQuestions(rows) {
    $('questions').innerHTML = rows.length
      ? rows.map(function (q) {
          return '<li><span class="tag">' + esc(STATUS[q.status] || q.status) + '</span>' + esc(q.text) + '<em>' + esc(when(q.since)) + '</em></li>'
        }).join('')
      : '<li class="empty">没有悬着的事。</li>'
  }

  function renderDreams(rows) {
    $('dreams').innerHTML = rows.length
      ? rows.map(function (d) {
          if (d.status === 'rejected') {
            var why = (d.rejected && d.rejected.length ? d.rejected.join('；') : '没过闸')
            return '<li class="dim"><span class="tag warn">没做成</span>' + esc(why) + '<em>' + esc(when(d.ts)) + '</em></li>'
          }
          return '<li><span class="tag' + (d.verified ? ' ok' : '') + '">' + (d.verified ? '核对过' : '没核过') + '</span>' + esc(d.hypothesis || d.text) + '<em>' + esc(when(d.ts)) + '</em></li>'
        }).join('')
      : '<li class="empty">还没做过梦。</li>'
  }

  function renderStudies(rows) {
    $('studies').innerHTML = rows.length
      ? rows.map(function (s) {
          var facts = (s.facts || []).slice(0, 2).map(function (f) { return '<span class="fact">' + esc(f) + '</span>' }).join('')
          var src = (s.sources || []).slice(0, 2).map(function (x) {
            return '<a href="' + esc(x.url || '') + '" target="_blank" rel="noreferrer">' + esc(x.title || x.url || '来源') + '</a>'
          }).join(' ')
          return '<li><span class="tag">查过</span>' + esc(s.question) + facts + '<em>' + src + '</em></li>'
        }).join('')
      : '<li class="empty">还没查过什么。</li>'
  }

  function renderNightly(n) {
    if (!n || !n.ok) return
    $('cNightly').textContent = age(n.last)
    if (n.last != null) $('cNightly').title = when(n.last)
    var due = n.due || {}
    var reasons = due.reasons || (due.reason ? [due.reason] : [])
    $('nightlyNote').textContent = due.ok ? '现在可以整理。' : (reasons.length ? '现在不用整理：' + reasons.join('；') : '现在不用整理。')
  }

  function renderSeed(s) {
    if (!s || !s.ok) return
    var form = $('seedForm')
    var current = $('seedCurrent')
    if (s.hasSeed) {
      form.hidden = true
      current.hidden = false
      var c = s.current || {}
      var frags = (c.fragments || []).map(function (t) { return '<p>' + esc(t) + '</p>' }).join('')
      $('seedCurrentText').innerHTML = frags || ('<p>' + esc(c.text || '') + '</p>')
      $('seedLimit').textContent = '已经写过，不能再改。' + (c.biasName ? '（' + c.biasName + '）' : '')
    } else {
      form.hidden = false
      current.hidden = true
    }
    if (s.adult && s.adult.available === false) $('adultBox').hidden = true
  }

  // 成年鱼入口：先选中那句话，才露出「她叫：派希丝 / 领养这条成年鱼」；不选就整块隐藏。
  var startMode = $('startMode')
  var adultBox = $('adultBox')
  if (startMode && adultBox) {
    startMode.addEventListener('change', function () {
      adultBox.hidden = !startMode.checked
    })
  }

  function reloadSoon() { setTimeout(function () { location.reload() }, 650) }

  var writeBtn = $('seedWrite')
  if (writeBtn) {
    writeBtn.addEventListener('click', function () {
      var text = $('seedText').value || ''
      var texts = text.split(/\\n\\s*\\n/).map(function (t) { return t.trim() }).filter(Boolean)
      var pick = document.querySelector('input[name="bias"]:checked')
      post('/seed', { texts: texts, bias: pick ? pick.value : 'balanced' }).then(function (r) {
        if (r && r.ok) { $('seedNote').textContent = '写下了。'; reloadSoon() }
        else $('seedNote').textContent = (r && (r.error || (r.problems || []).join('；'))) || '没写进去'
      })
    })
  }

  var adoptBtn = $('adoptBtn')
  if (adoptBtn) {
    adoptBtn.addEventListener('click', function () {
      post('/adopt', {}).then(function (r) {
        if (r && r.ok) { $('adoptNote').textContent = '领养了。'; reloadSoon() }
        else $('adoptNote').textContent = (r && r.error) || '没领养成功'
      })
    })
  }

  function action(path, body) {
    post(path, body).then(function (r) {
      $('nightlyNote').textContent = r && r.ok ? '做完了。' : ((r && r.error) || '没做成')
      reloadSoon()
    })
  }
  var nightlyBtn = $('nightlyBtn')
  if (nightlyBtn) nightlyBtn.addEventListener('click', function () { action('/nightly/run', { force: true }) })
  var verifyBtn = $('verifyBtn')
  if (verifyBtn) verifyBtn.addEventListener('click', function () { action('/verify', {}) })
  var learnBtn = $('learnBtn')
  if (learnBtn) learnBtn.addEventListener('click', function () { action('/learn', {}) })

  function load() {
    get('/state').then(renderState).catch(function () {})
    get('/nightly').then(renderNightly).catch(function () {})
    get('/questions').then(function (r) { renderQuestions((r && r.questions) || []) }).catch(function () {})
    get('/dreams').then(function (r) { renderDreams((r && r.dreams) || []) }).catch(function () {})
    get('/studies').then(function (r) { renderStudies((r && r.studies) || []) }).catch(function () {})
    get('/seed').then(renderSeed).catch(function () {})
  }

  load()
})()
</script>
</body>
</html>`
}
