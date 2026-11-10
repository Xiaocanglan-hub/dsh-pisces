// client.js（设置段）：用假 React 把 Panel 真渲染一遍，不依赖浏览器。
//
// client.test.mjs 只证明 bundle 能被 new Function 解析、源码里有哪些字符串；
// 这一份补的是"元素树真的长出来了"：在 vm 里跑源码拿到 factory，给一个最小假 React，
// 调 Panel() 后把返回的元素树（含函数式组件）深度展开，再断言文本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(HERE, '..', 'client.js')
const SRC = readFileSync(FILE, 'utf8')

const TAB_LABELS = ['状态', '设置', '心理活动', '原理', '反馈', '鸣谢']
const BANNED = ['性格', '好感度', '亲密度']

// ---------------------------------------------------------------------------
// 假 React：只够首次渲染跑完；state 更新不触发重渲染（测试不点按钮）。
// ---------------------------------------------------------------------------

function makeFakeReact() {
  const createElement = (type, props, ...children) => ({
    $$typeof: 'el',
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })

  const Children = {
    map: (children, fn) => (Array.isArray(children) ? children : [children]).map(fn),
    forEach: (children, fn) => (Array.isArray(children) ? children : [children]).forEach(fn),
    toArray: (children) => (Array.isArray(children) ? children : [children]),
    count: (children) => (Array.isArray(children) ? children.length : children == null ? 0 : 1),
    only: (children) => children,
  }

  return {
    createElement,
    Fragment: Symbol('F'),
    useState(init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useReducer(reducer, init) {
      return [typeof init === 'function' ? init() : init, () => {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return typeof getSnapshot === 'function' ? getSnapshot() : undefined
    },
    useContext() {
      return null
    },
    createContext(defaultValue) {
      return {
        _currentValue: defaultValue,
        Provider: ({ children }) => children,
        Consumer: () => null,
      }
    },
    memo(component) {
      return component
    },
    forwardRef(render) {
      return render
    },
    cloneElement(el, extra) {
      return { ...el, props: { ...el.props, ...(extra || {}) } }
    },
    Children,
  }
}

// ---------------------------------------------------------------------------
// 在 vm 里执行 bundle，拿 factory 返回值（只为了让 __ModuleLoader__.load 被调用）
// ---------------------------------------------------------------------------

function loadModule(fetchStub, makeReact = makeFakeReact) {
  let entry = null
  const fakeWindow = {
    __ModuleLoader__: {
      load(mod) {
        entry = mod
      },
    },
  }
  const sandbox = {
    window: fakeWindow,
    console,
    // Panel 首次渲染不取数（取数在 effect 里，假 React 不跑 effect），
    // 但仍兜一层：万一以后有人把 fetch 挪进渲染路径，也不会真联网。
    fetch: fetchStub,
    document: undefined,
  }
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox, { filename: 'client.js' })
  assert.ok(entry, 'bundle 应该调用一次 __ModuleLoader__.load')

  const react = makeReact()
  const mod = entry.factory((id) => {
    assert.equal(id, 'react', '客户端只能 require react')
    return react
  })
  return { mod, react }
}

// ---------------------------------------------------------------------------
// 渲染：Panel() → 元素树 → 深度展开函数组件 → 收集所有字符串
// ---------------------------------------------------------------------------

function renderNode(node, out) {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'function') return renderNode(node({}), out)
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, out)
    return out
  }
  if (typeof node !== 'object') return out

  const { type, props } = node
  if (typeof type === 'function') {
    const rendered =
      type.prototype && type.prototype.isReactComponent ? new type(props || {}).render() : type(props || {})
    return renderNode(rendered, out)
  }
  // 宿主标签（div/section/...）与 Fragment（Symbol）都只看 children。
  if (props) renderNode(props.children, out)
  return out
}

function findElement(node, pred) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, pred)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (node.$$typeof === 'el' && pred(node)) return node
  return findElement(node.props && node.props.children, pred)
}

function renderPanel() {
  const fetchStub = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchStub
  try {
    const { mod } = loadModule(fetchStub)
    assert.equal(typeof mod.Panel, 'function')
    const tree = mod.Panel({})
    const texts = renderNode(tree, [])
    return { tree, texts, text: texts.join('\n'), mod }
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---------------------------------------------------------------------------
// 能"记住 setState 再渲染一次"的最小 React：只服务"点页签切页"这一个用例。
// Panel 自己那次调用才记状态；子组件渲染（renderNode 里）走假 React 的固定值。
// ---------------------------------------------------------------------------

function makeClickReact() {
  const base = makeFakeReact()
  const state = []
  let cursor = 0
  let live = false
  return {
    ...base,
    beginRender() {
      cursor = 0
      live = true
    },
    endRender() {
      live = false
    },
    useState(init) {
      if (!live) return base.useState(init)
      const i = cursor++
      if (!(i in state)) state[i] = typeof init === 'function' ? init() : init
      return [
        state[i],
        (next) => {
          state[i] = typeof next === 'function' ? next(state[i]) : next
        },
      ]
    },
  }
}

/** 返回 render()：调一次 = 渲染一次 Panel，保留上次 setState 的值。 */
function renderPanelClickable() {
  const fetchStub = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  const react = makeClickReact()
  const { mod } = loadModule(fetchStub, () => react)
  const render = () => {
    react.beginRender()
    const tree = mod.Panel({})
    react.endRender()
    return tree
  }
  return { mod, render }
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

test('Panel 首次渲染不抛，六个页签的文本真的在元素树里', () => {
  const { text } = renderPanel()

  for (const label of TAB_LABELS) {
    assert.ok(text.includes(label), `页签「${label}」没有渲染出来`)
  }
  assert.ok(text.includes('派希丝'), '标题「派希丝」没有渲染出来')
  // 首次渲染 snap=null、loading=true，应该至少有一句加载态/空状态的人话。
  assert.match(text, /读取中|正在读她的状态|还没有/, '首次渲染没有任何加载态或空状态文案')
})

test('页签行恰好六个按钮，标签与顺序都对', () => {
  const { tree } = renderPanel()
  const tabs = findElement(tree, (el) => el.props && el.props.className === 'tabs')
  assert.ok(tabs, '元素树里找不到 .tabs 容器')

  const buttons = Array.from(tabs.props.children)
  assert.equal(buttons.length, 6, `页签按钮应该 6 个，实际 ${buttons.length} 个`)
  assert.deepEqual(
    buttons.map((b) => b.props.children),
    TAB_LABELS,
  )
})

test('点「鸣谢」页签：切到第六页，来源与底部小字都在', () => {
  const { render } = renderPanelClickable()
  const tabs = findElement(render(), (el) => el.props && el.props.className === 'tabs')
  const button = Array.from(tabs.props.children).find((b) => b.props.children === '鸣谢')
  assert.ok(button, '页签行里没有「鸣谢」按钮')

  button.props.onClick()

  const text = renderNode(render(), []).join('\n')
  for (const word of [
    '鸣谢',
    'dsh-fish',
    'dsh-fish-memory',
    'Character Card V2',
    'dsh-companion',
    'Generative Agents',
    'DeepSeek Harness',
    '双鱼座',
    '所有养过鱼的人',
  ]) {
    assert.ok(text.includes(word), `鸣谢页缺「${word}」`)
  }
  assert.ok(text.includes('https://www.npmjs.com/package/@ssamurias/dsh-fish'), '鸣谢页缺 dsh-fish 的 npm 链接')
  assert.ok(!text.includes('dsh-purge'), 'dsh-purge 是隐藏项目，不该出现在鸣谢里')
  for (const word of ['dsh-whale-memory', 'dsh-memory-brain', 'dsh-school', 'dsh-slow-wave', 'dafeiyu_persona_core']) {
    assert.ok(!text.includes(word), `用户自己的插件「${word}」不该出现在鸣谢里`)
  }
  assert.ok(!text.includes('dsh-fish-river'), '流水层没实现，不该出现在鸣谢里')
  assert.ok(!text.includes('DUMA'), 'DUMA/双流的机制不符，不该出现在鸣谢里')
  assert.ok(!text.includes('晓晓'), '语音声线不进鸣谢')
  assert.ok(!text.includes('edge-tts'), '语音声线不进鸣谢')
  assert.ok(text.includes('发反馈告诉我们'), '底部小字「发反馈告诉我们」没渲染')
})

test('渲染结果有实际内容，且不出现性格/好感度/亲密度', () => {
  const { texts, text } = renderPanel()
  // 首次渲染是状态页：标题/副标题 + 6 个页签 + 加载提示 + 状态卡若干句。
  assert.ok(texts.length >= 10, `渲染出的字符串太少：${texts.length}`)

  for (const word of BANNED) {
    assert.ok(!text.includes(word), `渲染结果里不该出现「${word}」`)
  }
})

// ---------------------------------------------------------------------------
// 状态页顶部的「起点」：照观测台网页版，空库写三句话 / 领养成年鱼
// ---------------------------------------------------------------------------

const EMPTY_SEED = {
  ok: true,
  hasSeed: false,
  canWrite: true,
  current: null,
  limits: { fragments: 3, fragment: 200, total: 500 },
  biases: [
    { id: 'balanced', name: '两边都算（默认）', hint: '没有偏向，靠经历慢慢长出来' },
    { id: 'rational', name: '先算一遍', hint: '先把边界算清楚，再开口' },
    { id: 'intuitive', name: '先凭感觉', hint: '先有反应，再回头核对' },
  ],
  adult: {
    name: '派希丝',
    label: '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼',
    available: true,
  },
}

const WRITTEN_SEED = {
  ...EMPTY_SEED,
  hasSeed: true,
  canWrite: false,
  current: {
    text: '喜欢下雨天\n\n讨厌被催',
    fragments: ['喜欢下雨天', '讨厌被催'],
    chars: 10,
    bias: 'balanced',
    biasName: '两边都算（默认）',
  },
  adult: { ...EMPTY_SEED.adult, available: false },
}

/** 展开函数组件，拿到所有宿主元素（findElement 不展开组件，起点卡在 SeedCard 里）。 */
function flatElements(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'function') {
    flatElements(node({}), out)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatElements(child, out)
    return out
  }
  if (typeof node !== 'object') return out

  const { type, props } = node
  if (typeof type === 'function') {
    const rendered =
      type.prototype && type.prototype.isReactComponent ? new type(props || {}).render() : type(props || {})
    return flatElements(rendered, out)
  }
  out.push(node)
  if (props) flatElements(props.children, out)
  return out
}

function findButton(node, label) {
  return flatElements(node).find((el) => el.type === 'button' && el.props && el.props.children === label) || null
}

function hasTag(node, tag) {
  return flatElements(node).some((el) => el.type === tag)
}

/** 直接渲染状态页；假的 fetch 记录每次调用，供"点按钮有没有发 POST"用。 */
function renderStatus(props) {
  const calls = []
  const fetchStub = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, name: '派希丝' }) })
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = fetchStub
  try {
    const { mod } = loadModule(fetchStub)
    assert.equal(typeof mod.StatusTab, 'function', '模块应导出 StatusTab 供测试注入初值')
    const tree = mod.StatusTab(props)
    const texts = renderNode(tree, [])
    return { tree, texts, text: texts.join('\n'), calls }
  } finally {
    globalThis.fetch = realFetch
  }
}

test('空库的状态页：起点区在，写的人话、上限、三个偏向、成年鱼那句都在', () => {
  const { text } = renderStatus({ seedOverride: EMPTY_SEED })

  assert.ok(text.includes('还没开始'), '空库应该有「还没开始」')
  assert.ok(text.includes('最多 3 段'), '上限应该用 /seed 返回的 limits，不是写死')
  assert.ok(text.includes('每段不超过 200 字'), '每段上限没显示')
  assert.ok(text.includes('合计不超过 500 字'), '合计上限没显示')
  assert.ok(text.includes('养鱼新手不要调整'), '应该提示新手别调偏向')
  for (const name of ['两边都算（默认）', '先算一遍', '先凭感觉']) {
    assert.ok(text.includes(name), `偏向「${name}」没有渲染出来`)
  }
  assert.ok(text.includes('我是啥也不懂的新手小白'), '成年鱼入口那句话没渲染出来')
})

test('成年鱼入口默认隐藏：不选中就没有领养按钮', () => {
  const { tree } = renderStatus({ seedOverride: EMPTY_SEED })
  assert.equal(findButton(tree, '领养这条成年鱼'), null, '不选成年鱼不该出现领养按钮')
  assert.ok(hasTag(tree, 'textarea'), '不选成年鱼时应该有起点 textarea')
})

test('选中成年鱼：出现「她叫：派希丝」和领养按钮，textarea 与「写下去」都不出现', () => {
  const { tree, text } = renderStatus({ seedOverride: EMPTY_SEED, adultPicked: true })

  assert.ok(text.includes('她叫：'), '选中后应显示「她叫：」')
  assert.ok(text.includes('派希丝'), '选中后应显示「派希丝」')
  assert.ok(findButton(tree, '领养这条成年鱼'), '选中后应出现领养按钮')
  assert.equal(hasTag(tree, 'textarea'), false, '选中成年鱼时不该同时出现 textarea')
  assert.equal(findButton(tree, '写下去'), null, '选中成年鱼时不该同时出现「写下去」')
})

test('已有起点：显示「起点已写」和「起点只写一次」，没有 textarea', () => {
  const { tree, text } = renderStatus({ seedOverride: WRITTEN_SEED })

  assert.ok(text.includes('起点已写'), '已有起点时应显示「起点已写」')
  assert.ok(text.includes('起点只写一次'), '已有起点时应提示「起点只写一次，不能改」')
  assert.ok(text.includes('喜欢下雨天'), '已有起点的正文应该只读显示')
  assert.equal(hasTag(tree, 'textarea'), false, '已有起点时不该出现 textarea')
})

test('点「领养这条成年鱼」发出一句 POST /adopt', async () => {
  const { tree, calls } = renderStatus({ seedOverride: EMPTY_SEED, adultPicked: true })
  const button = findButton(tree, '领养这条成年鱼')
  assert.ok(button, '领养按钮不存在')

  await button.props.onClick({})

  const post = calls.find((c) => c.url.includes('/adopt'))
  assert.ok(post, '没有发出 POST /adopt')
  assert.equal(post.opts.method, 'POST')
  assert.equal(post.url, '/dsh-pisces-api/adopt')
})

test('点「写下去」POST /seed：texts 是拆好的段、bias 是选中的值', async () => {
  const { tree, calls } = renderStatus({
    seedOverride: EMPTY_SEED,
    textOverride: '喜欢下雨天\n\n讨厌被催\n想学做菜',
    biasOverride: 'rational',
  })
  const button = findButton(tree, '写下去')
  assert.ok(button, '「写下去」按钮不存在')

  await button.props.onClick({})

  const post = calls.find((c) => c.url.includes('/seed'))
  assert.ok(post, '没有发出 POST /seed')
  assert.equal(post.opts.method, 'POST')
  const body = JSON.parse(post.opts.body)
  assert.deepEqual(body.texts, ['喜欢下雨天', '讨厌被催', '想学做菜'])
  assert.equal(body.bias, 'rational')
})

// ---------------------------------------------------------------------------
// 成年鱼的状态面板：按 /state.reveal 把没揭开的块渲染成模糊 + ？？？
// ---------------------------------------------------------------------------

const LOCKED_ALL = {
  day: false,
  events: false,
  order: true,
  dominance: true,
  attribution: true,
  openQuestions: true,
  dreams: true,
  verified: true,
  refusals: true,
  scars: true,
}

function adultSnap(reveal) {
  return {
    state: {
      ok: true,
      day: 2,
      events: 6,
      order: 'E=R',
      dominance: 0.5,
      band: null,
      attribution: { d: 2, i: 3, null: 1, total: 6 },
      openQuestions: 1,
      dreams: 1,
      verified: 0,
      refusals: 4,
      scars: 2,
      recent: [],
      demo: { name: '派希丝', label: '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼' },
      reveal,
      masked: {},
    },
    nightly: null,
    recent: [],
  }
}

test('成年鱼 L2：没揭开的块是 ？？？ + 「再聊 N 次」提示，已揭开的照常显示', () => {
  const { text, tree } = renderStatus({
    snap: adultSnap({
      level: 2,
      next: { level: 3, needEvents: 8, needDays: 4 },
      locked: LOCKED_ALL,
      depth: 6,
      days: 2,
      baselineSeq: 1,
    }),
    seedOverride: WRITTEN_SEED,
  })

  assert.ok(text.includes('？？？'), '被锁的统计块应该显示 ？？？')
  assert.ok(text.includes('再聊 8 次'), '应该提示再聊几次就揭开')
  assert.ok(text.includes('多陪她 4 天'), '天数那条提示也应该在')
  assert.ok(flatElements(tree).some((el) => el.props && el.props.className === 'veil'), '没揭开的块应该带模糊层')
})

test('成年鱼 L6：全部揭开后不再有 ？？？，拒绝与疤的计数直接显示', () => {
  const none = Object.fromEntries(Object.keys(LOCKED_ALL).map((k) => [k, false]))
  const { text, tree } = renderStatus({
    snap: adultSnap({
      level: 6,
      next: null,
      locked: none,
      depth: 80,
      days: 30,
      baselineSeq: 1,
    }),
    seedOverride: WRITTEN_SEED,
  })

  assert.ok(!text.includes('？？？'), '全揭开后不该再有 ？？？')
  assert.ok(!text.includes('就告诉你'), '全揭开后不该再有提示')
  assert.ok(text.includes('拒绝'), '「拒绝」统计块应该在')
  assert.ok(text.includes('疤'), '「疤」统计块应该在')
  assert.equal(flatElements(tree).filter((el) => el.props && el.props.className === 'veil').length, 0, '不该再有模糊块')
})

// ---------------------------------------------------------------------------
// 好感卡：普通鱼直接给数字；被 reveal 遮住时只有心形和档名
// ---------------------------------------------------------------------------

/** 状态页的最小 snap：只放好感卡要读的字段，其余留空走"没有"分支。 */
function affinitySnap(affinity) {
  return {
    state: {
      ok: true,
      day: 5,
      events: 12,
      order: 'E=R',
      dominance: 0.5,
      band: null,
      attribution: { d: 1, i: 1, null: 0, total: 2 },
      openQuestions: 0,
      dreams: 0,
      verified: 0,
      refusals: 0,
      scars: 0,
      recent: [],
      affinity,
    },
    nightly: null,
    recent: [],
  }
}

test('好感卡：普通鱼给心形（tier+1 颗）+ 档名 + 数字', () => {
  const { text } = renderStatus({
    snap: affinitySnap({ value: 42.5, tier: 2, label: '亲近', nextAt: 60, days: 5, earned: 32.5, lost: 0, masked: false }),
    seedOverride: WRITTEN_SEED,
  })

  assert.ok(text.includes('好感'), '应该有「好感」卡')
  assert.ok(text.includes('♥♥♥'), 'tier 2 应该画 3 颗心')
  assert.ok(text.includes('亲近'), '档名应该显示')
  assert.ok(text.includes('42.5'), '普通鱼不遮，数字应该显示')
  assert.ok(text.includes('到 60 再上一档'), '下一档门槛应该显示')
})

test('好感卡：被遮时显示 ？？？ 和「聊深一点才告诉你」，心形与档名照旧', () => {
  const { text } = renderStatus({
    snap: affinitySnap({ value: null, earned: null, lost: null, tier: 1, label: '眼熟', nextAt: 40, days: 2, masked: true }),
    seedOverride: WRITTEN_SEED,
  })

  assert.ok(text.includes('♥♥'), 'tier 1 应该画 2 颗心（心意看得见）')
  assert.ok(text.includes('眼熟'), '档名不遮')
  assert.ok(text.includes('？？？'), '数字应该被遮成 ？？？')
  assert.ok(text.includes('聊深一点'), '应该有一句「聊深一点才告诉你」')
})

// ---------------------------------------------------------------------------
// 设置页：由 /settings 的 schema 驱动；反馈页：加群入口
// ---------------------------------------------------------------------------

const SETTINGS_SCHEMA = [
  { path: 'tools.narrow', kind: 'bool', label: '工具收窄', hint: '只让她看见自己的工具，别的会话不受影响', restart: true },
  { path: 'panel.affinity', kind: 'bool', label: '面板显示好感', hint: '状态页里的好感读数', restart: false },
  {
    path: 'dual.mode',
    kind: 'enum',
    label: '双流档位',
    hint: 'A / B',
    options: [
      { value: 'A', label: 'A 档（暗栏）' },
      { value: 'B', label: 'B 档（顺序）' },
    ],
    restart: true,
  },
  { path: 'bili.qrLogin', kind: 'string', label: 'B 站登录状态', hint: '只读', readOnly: true, restart: false },
]

const SETTINGS_DATA = {
  ok: true,
  root: 'C:\\data',
  schema: SETTINGS_SCHEMA,
  settings: {
    tools: { narrow: false, allow: 'hers' },
    dual: { mode: 'A' },
    panel: { affinity: true },
    bili: { qrLogin: 'idle' },
  },
}

function loadClient() {
  const fetchStub = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  return loadModule(fetchStub)
}

function renderSettings() {
  const { mod } = loadClient()
  assert.equal(typeof mod.SettingsTab, 'function', '模块应导出 SettingsTab 供测试渲染')
  const tree = mod.SettingsTab({ data: SETTINGS_DATA })
  const texts = renderNode(tree, [])
  return { tree, texts, text: texts.join('\n') }
}

test('设置页由 schema 渲染：工具收窄、保存设置、她的数据、B 站只读状态都在', () => {
  const { text } = renderSettings()

  assert.ok(text.includes('工具收窄'), 'schema 里的 bool 标签没渲染')
  assert.ok(text.includes('面板显示好感'), 'schema 里的第二项没渲染')
  assert.ok(text.includes('保存设置'), '保存按钮没渲染')
  assert.ok(text.includes('她的数据：C:\\data'), '数据根没显示')
  assert.ok(text.includes('未登录'), 'B 站登录状态没显示')
  assert.ok(text.includes('扫码登录（下一步接）'), '扫码登录占位按钮没显示')
})

test('schema 里 restart:true 的项带「保存后需重启」，restart:false 的不带', () => {
  const { tree, text } = renderSettings()
  const badges = flatElements(tree).filter((el) => el.props && el.props.className === 'badge')

  assert.equal(badges.length, 2, '只有 tools.narrow 与 dual.mode 标重启')
  assert.ok(badges.every((b) => b.props.children === '保存后需重启'))
  assert.ok(text.includes('保存后需重启'), '重启小标没渲染出来')
})

test('反馈页有加群入口：群名、群号、链接、二维码图都在', () => {
  const { mod } = loadClient()
  assert.equal(typeof mod.FeedbackTab, 'function', '模块应导出 FeedbackTab 供测试渲染')
  const tree = mod.FeedbackTab({ value: '', note: '', onChange() {}, onSave() {} })
  const text = renderNode(tree, []).join('\n')

  assert.ok(text.includes('鱼肥生双交流群'), '群名没渲染')
  assert.ok(text.includes('129448233'), '群号没渲染')
  assert.ok(text.includes('qm.qq.com'), '加群链接没渲染')
  const img = flatElements(tree).find((el) => el.type === 'img')
  assert.ok(img, '二维码图没渲染')
  assert.equal(img.props.src, '/dsh-pisces-api/qq')
  assert.equal(img.props.alt, '鱼肥生双交流群二维码')
})

// ---------------------------------------------------------------------------
// 称呼卡：成年鱼才有；显示当前昵称或「还没起昵称」，一个输入框 + 一个按钮
// ---------------------------------------------------------------------------

test('称呼卡：成年鱼状态页有「称呼」「就叫这个」，没有昵称时提示还没起', () => {
  const snap = adultSnap({ level: 2, next: null, locked: LOCKED_ALL, depth: 6, days: 2, baselineSeq: 1 })
  const empty = renderStatus({ snap, seedOverride: WRITTEN_SEED })
  assert.ok(empty.text.includes('称呼'), '成年鱼应有「称呼」卡')
  assert.ok(empty.text.includes('还没起昵称'), '还没有昵称时该提示「还没起昵称」')
  assert.ok(empty.text.includes('就叫这个'), '输入框旁边应有「就叫这个」按钮')
  const input = flatElements(empty.tree).find((el) => el.type === 'input' && el.props && el.props.className === 'nick')
  assert.ok(input, '称呼卡应该有一个输入框')
  assert.equal(input.props.maxLength, 12)

  snap.nickname = '小鱼'
  const named = renderStatus({ snap, seedOverride: WRITTEN_SEED })
  assert.ok(named.text.includes('现在叫：小鱼'), '有昵称时该显示当前昵称')
})

test('称呼卡：普通鱼状态页没有称呼卡、没有「就叫这个」', () => {
  const snap = affinitySnap({ value: 12.5, tier: 0, label: '陌生', nextAt: 20, days: 2, earned: 2.5, lost: 0, masked: false })
  snap.nickname = '小鱼' // 就算接口给了名字，普通鱼也不该出这张卡
  const { text, tree } = renderStatus({ snap, seedOverride: WRITTEN_SEED })

  assert.ok(!text.includes('称呼'), '普通鱼不该有称呼卡')
  assert.ok(!text.includes('就叫这个'), '普通鱼不该有改昵称按钮')
  assert.equal(findButton(tree, '就叫这个'), null)
  assert.equal(flatElements(tree).some((el) => el.type === 'input' && el.props && el.props.className === 'nick'), false)
})

// ---------------------------------------------------------------------------
// 百度贴吧登录：只收 BDUSS/STOKEN，粘贴 + 保存并验证；不做扫码/QQ/微信
// ---------------------------------------------------------------------------

function renderBaiduCard() {
  const { tree } = renderSettings()
  const section = flatElements(tree).find(
    (el) =>
      el.type === 'section' &&
      flatElements(el).some((c) => c.type === 'h3' && renderNode(c, []).join('') === '百度贴吧'),
  )
  assert.ok(section, '设置页应该有「百度贴吧」卡')
  return { section, text: renderNode(section, []).join('\n') }
}

test('设置页有百度贴吧入口：textarea 占位、保存并验证、取 cookie 的说明都在', () => {
  const { section, text } = renderBaiduCard()

  assert.ok(text.includes('百度贴吧'), '卡名没渲染')
  assert.ok(text.includes('保存并验证'), '保存按钮没渲染')
  assert.ok(text.includes('F12'), '取 cookie 的说明没渲染')

  const ta = flatElements(section).find((el) => el.type === 'textarea')
  assert.ok(ta, '应该有一个 textarea')
  assert.equal(ta.props.placeholder, '把浏览器的 BDUSS=…; STOKEN=… 贴进来')
})

test('百度贴吧状态默认显示「未登录」，没有扫码/QQ/微信', () => {
  const { section, text } = renderBaiduCard()

  assert.ok(text.includes('登录状态：未登录'), '没登录时应显示「未登录」')
  assert.ok(!text.includes('扫码'), '贴吧不做扫码')
  assert.ok(!text.includes('微信'), '贴吧不接微信')
  assert.ok(findButton(section, '保存并验证'), '保存并验证按钮应该是可点的 button')
})


