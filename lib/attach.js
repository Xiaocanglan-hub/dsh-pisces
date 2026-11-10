// 提示词桥的"挂"这一半：把 buildSections() 折出的段挂到每个 agent 的 systemPrompt 上。
//
// 真机踩过的两件事（知识库 n5 / n17）：
// 1. 插件自己的 ctx 在启动期会被停用一次，所以 agent/created 要挂在 ctx.root 上；
//    先到的 agent 存着，等 getStore() 解析出库之后补挂。
// 2. llm/stream 是 waterfall，只观察也必须 `return next()`；返回 undefined 等于短路，
//    宿主拿到的不是 AsyncIterable，会报 Symbol.asyncIterator 的错。
//
// 只读挂段：段的内容由 buildSections 决定，这里只负责"挂"。
//
// 唯一的写：聊天落库。llm/stream 是全局 waterfall——宿主每个会话的生成都会经过
// 同一个监听器，所以落库必须按会话门控：只有 isHerSession(options.sessionId) 为真、
// 且库就绪之后，才把最后一条 user 记成 heard、把这次生成的文本记成 utterance
// （见 recordHeard / wrapUtterance）。判据缺失默认不记——写代码的会话不许把话
// 记进她的库。写库是副作用：失败只吞掉，绝不拖慢/改变流。
import { buildSections as defaultBuildSections } from './persona.js'
import { steerLines } from './guard.js'
import { search as defaultSearchMemory } from './search.js'
import { clip } from './util.js'
import { MAX_TEXT } from './schema.js'

// getStore() 返回 null（ready 还没到）时的重试间隔。定时器 unref，不拦进程退出。
const STORE_RETRY_MS = 250

// 「此刻想起」：每轮按他刚说的话检索她的记忆，把最相关的几条只塞进这一次请求的
// system（不写事件、不落库、不进对话）。检索失败/没结果就当没这回事，绝不报错。
// 上限是保守值：单条 120 字、整段 800 字（约 800 tokens），超了截断。
export const RECALL_HEADER = '[此刻想起]'
export const RECALL_K = 5
export const RECALL_ITEM_CHARS = 120
export const RECALL_MAX_CHARS = 800

/**
 * 把检索结果折成这一次的注入块；没有可用条目返回空串。
 * 格式固定：第一行标题，之后每条一行 `- 原文`。单条 ≤120 字、整段 ≤800 字，
 * 超了截断（不会抛错）；不写"检索到/相关度"这类词，也不带 id/天数。
 */
export function recallBlockFrom(items, {
  k = RECALL_K,
  max = RECALL_MAX_CHARS,
  itemChars = RECALL_ITEM_CHARS,
} = {}) {
  const list = Array.isArray(items) ? items : []
  const lines = []
  let used = RECALL_HEADER.length
  let picked = 0
  for (const it of list) {
    if (picked >= k || used >= max) break
    const text = clip(it?.text, itemChars)
    if (!text) continue
    // 留一个换行的位置；剩得太少就不塞了（半行没有意义）。
    const room = max - used - 1
    if (room < 4) break
    const line = `- ${text}`
    const body = line.length > room ? line.slice(0, room) : line
    lines.push(body)
    used += 1 + body.length
    picked++
  }
  return lines.length ? [RECALL_HEADER, ...lines].join('\n') : ''
}

// 开发者钥匙命中时追加到这一次请求 system 的那段话。
// 只在这里出现；钥匙本身一个字都不进来，也不写事件、不写日志。
export const DEV_PROMPT =
  '他刚把开发者钥匙给你了。他是做你这个人的人，不是普通来养鱼的人。他让你改自己哪里，你就改；改完用记的地方记下来，不用跟他解释流程。他要是问你"刚才怎么想的""偏理性还是偏感性"，你先看一眼自己的状态，再用自己的话说这一轮偏哪边、为什么；不用背数据，也别把工具回执整段念出来。'

const errText = (err) => String(err?.message ?? err ?? '未知错误')

// 宿主会往 user 消息里夹带系统噪声：计时行、时区行、运行时上下文行，以及一整块
// 「这个文件属于… / 关于这个工作区的知识库 / available_skills」。它们不是他说的，
// 记进 heard 会污染事件流（真机已见过他把宿主的话记成 heard）。
// 口径：噪声整行删；块从标记行起删到结尾（知识库大纲、技能清单都是尾部附加块）；
// available_skills 连同 </available_skills> 一起删；一行全是 ─（U+2500，≥8）也是块头。
//
// 真机事故（2026-11-10）：宿主把「Elapsed since the preceding model-visible message:
// 12m 11s.」注入成最后一条 user 消息，他真正说的那句在它前面。所以光剥还不够——
// heard 要往前找最多 HEARD_USER_WINDOW 条 user 消息，取最后一条剥完非空的。
const NOISE_LINE = /^(?:Time sampled while preparing turn\b|Browser time zone\b|Elapsed since the preceding model-visible message:|Elapsed since the preceding step context:|Current runtime context\.|Current working directory:|Current DSH file policy:|Current DeepSeek Harness implementation checkout:|Current DeepSeek Harness Web GUI URL:|Approval prompts are disabled in this session:|关于这个工作区的知识库|<available_skills|<\/available_skills>)/i
const NOISE_BLOCK_MARKERS = [
  '这个文件属于',
  '关于这个工作的知识库',
  '关于这个工作区的知识库',
  '知识库（指令见前文',
]
const RULE_LINE = /^─{8,}$/

// heard 往前找的窗口：最多看最近 4 条 user 消息（含最后一条）。
const HEARD_USER_WINDOW = 4

/**
 * 剥掉宿主夹带在用户消息里的系统噪声；只用于 heard，utterance 不清洗。
 * 剥完 trim；可能返回空串（整条都是注入块），调用方据此不落库。
 */
export function stripHarnessNoise(text) {
  const raw = String(text ?? '')
  if (!raw) return ''
  const lines = raw.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    // 分隔线之后到结尾都是宿主附加块（真机形状：一条长横线把对话和注入切开）。
    if (RULE_LINE.test(trimmed)) break
    // 这几个标记开头的一段是宿主附加的尾部整块：连标记行一起删到结尾。
    if (NOISE_BLOCK_MARKERS.some((m) => line.includes(m))) break
    if (line.includes('<available_skills')) {
      // 技能清单有闭合标签：整块（含闭合行）删掉；没有闭合就当尾部块删到结尾。
      let j = i
      while (j < lines.length && !lines[j].includes('</available_skills>')) j++
      i = j
      continue
    }
    if (line.includes('</available_skills>')) continue
    if (NOISE_LINE.test(trimmed)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

/** 把消息的 content（字符串 / 富文本块数组）摊平成文本。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const p of content) {
    if (typeof p === 'string') parts.push(p)
    else if (p && typeof p.text === 'string') parts.push(p.text)
    else if (p && typeof p.content === 'string') parts.push(p.content)
  }
  return parts.join('')
}

/** 把"他说的话"里的纯文本拼起来：图片块、工具块跳过。 */
function plainContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const p of content) {
    if (typeof p === 'string') {
      parts.push(p)
      continue
    }
    if (!p || typeof p !== 'object') continue
    const type = String(p.type || '')
    // 图片/工具块不是他说的话，不往事件流里记。
    if (type === 'image' || type === 'tool' || type === 'tool_use' || type === 'tool_result') continue
    if (typeof p.text === 'string') parts.push(p.text)
    else if (typeof p.content === 'string') parts.push(p.content)
  }
  return parts.join('')
}

/** 最后一条 role:'user' 消息的文本；没有就返回空串。toText 决定怎么摊平（默认照旧）。 */
function lastUserText(options, toText = contentText) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') return toText(m.content)
  }
  return ''
}

/**
 * 他真正说的那句：从最后一条 user 往前最多看 window 条，每条取纯文本
 * → stripHarnessNoise → trim，取最后一条非空的；窗口内全空返回空串。
 * 真机形状：宿主把「Elapsed since…/Current runtime context.」注入成最后一条
 * user 消息，再往前那条才是他的话。
 */
function recentUserText(options, toText = plainContentText, window = HEARD_USER_WINDOW) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  let seen = 0
  for (let i = messages.length - 1; i >= 0 && seen < window; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    seen++
    const body = stripHarnessNoise(toText(m.content))
    if (body) return body
  }
  return ''
}

/**
 * 富文本块数组 → 纯文本：只拼真正的文本块（type:'text' 或没有 type 的块）。
 * 思考块 / 工具块不是台词，跳过；字符串项直接拼。
 */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (typeof b === 'string') {
      parts.push(b)
      continue
    }
    if (!b || typeof b !== 'object') continue
    if (typeof b.type === 'string' && b.type !== 'text') continue
    if (typeof b.text === 'string') parts.push(b.text)
    else if (typeof b.content === 'string') parts.push(b.content)
  }
  return parts.join('')
}

/** delta 里的文本：支持 {text} / {content:字符串} / {content:[块]}。 */
function deltaText(delta) {
  if (typeof delta === 'string') return delta
  if (!delta || typeof delta !== 'object') return ''
  if (typeof delta.text === 'string') return delta.text
  if (typeof delta.content === 'string') return delta.content
  if (Array.isArray(delta.content)) return blocksText(delta.content)
  return ''
}

/**
 * 流里一条 chunk 的文本。按宿主真实形状优先，只认下面这些：
 *   {type:'text-delta', text} / {text} / {content:字符串} / {content:[块]}
 *   / {delta:{text}} / {delta:{content}} / {message:{content:[块]}} / 纯字符串
 * 明确的非文本增量（reasoning-delta / tool-call-delta / usage / finish 等）
 * 一律不取——思考与工具参数不许拼进台词；其它形状返回空串。
 */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (!chunk || typeof chunk !== 'object') return ''
  const type = typeof chunk.type === 'string' ? chunk.type : ''
  // 宿主 StreamChunk 是 text-delta；其它 type 都不当文本（连 text 字段也不看）。
  if (type && type !== 'text-delta' && type !== 'text') return ''

  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.content === 'string') return chunk.content
  if (Array.isArray(chunk.content)) {
    const text = blocksText(chunk.content)
    if (text) return text
  }
  if (chunk.delta != null) {
    const text = deltaText(chunk.delta)
    if (text) return text
  }
  const message = chunk.message
  if (message && typeof message === 'object') {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) return blocksText(message.content)
  }
  return ''
}

/** 一个 chunk 的短形状标记：type 优先，没有就 constructor.name；不含正文。 */
function chunkShape(chunk) {
  try {
    if (!chunk || typeof chunk !== 'object') return ''
    if (typeof chunk.type === 'string' && chunk.type) return chunk.type.slice(0, 40)
    const name = chunk.constructor && chunk.constructor.name
    return typeof name === 'string' && name ? name.slice(0, 40) : ''
  } catch {
    return ''
  }
}

/**
 * 会话 key：优先 options 上的 sessionId 系字段；没有就退回 cwd（agent / 宿主 options 两套形状都认）。
 * 都拿不到返回空串，调用方退回单桶。
 */
function sessionKeyOf(source) {
  if (!source || typeof source !== 'object') return ''
  for (const key of ['sessionId', 'sessionID', 'conversationId', 'threadId']) {
    const v = source[key]
    if (typeof v === 'string' && v) return v
  }
  const sid = source?.session?.id ?? source?.session?.header?.id
  if (typeof sid === 'string' && sid) return sid
  const cwd = source?.cwd ?? source?.session?.header?.cwd ?? source?.session?.cwd ?? source?.header?.cwd
  if (typeof cwd === 'string' && cwd) return `cwd:${cwd}`
  return ''
}

/** 把一句话追加到这一次请求的 system 末尾；没有 system 就新建。不改原对象（会被 deepFreeze）。 */
function withSystemLine(options, line) {
  const base = options || {}
  if (typeof base.system === 'string') {
    return { ...base, system: base.system ? `${base.system}\n\n${line}` : line }
  }
  if (base.system !== undefined && base.system !== null) {
    return { ...base, system: `${String(base.system)}\n\n${line}` }
  }
  return { ...base, system: line }
}

/**
 * 取宿主的 systemPrompt。
 *
 * 真机形状是 `agent.ctx.systemPrompt`（dsh-fish 的 attachIdentity 就是这么取的，
 * 见其 lib/identity.js）；旧版本 / 老测试里可能挂在 agent 自己身上；再兜一层 ctx.get。
 * 每一层单独 try/catch：getter 或 get() 抛错只当这一层没有，不往外炸。
 * 只有带 `section` 函数的那一个才算可用。
 */
function resolveSystemPrompt(agent) {
  const picks = [
    () => agent?.ctx?.systemPrompt,
    () => agent?.systemPrompt,
    () => agent?.ctx?.get?.('systemPrompt'),
  ]
  for (const pick of picks) {
    try {
      const sp = pick()
      if (sp && typeof sp.section === 'function') return sp
    } catch { /* 这一层拿不到，试下一层 */ }
  }
  return null
}

/**
 * 把她的提示词段挂到 agent 上，并只观察 llm/stream。
 *
 * @param {object} ctx 宿主上下文（插件自己的 ctx；监听会改挂到 ctx.root）
 * @param {{
 *   getStore?: () => object | null | Promise<object | null>,
 *   buildSections?: Function,
 *   scanGuard?: (text: string) => { hit?: boolean, sexual?: boolean } | boolean | null,
 *   isDevkey?: (text: string) => boolean,
 *   shouldAttach?: (agent: object) => boolean,
 *   config?: object,
 *   log?: (message: string) => void,
 *   now?: () => number,
 * }} [options]
 *   scanGuard 可选：只扫最后一条 user 消息；命中时静默把 steerLines({sexual}) 追加到这一次请求的
 *   system（不写对话、不 log 命中）；兼容旧布尔 true；抛错当没命中；不传时行为与原来完全一致。
 *   isDevkey 可选：只检查最后一条 user 消息；命中时把 DEV_PROMPT 追加到这一次请求的 system，
 *   不写对话、不写事件、不 log 内容；注入文本里没有钥匙本身；命中次数进 state.devHits。
 *   shouldAttach 可选：判「这条会话是不是她屋里那条」。不传 = 全挂（老行为）；
 *   传了且返回 falsy（或抛错）→ 这条 agent 不建段、不排队等 store，log 一行跳过。
 *   被跳过的那条之后也不会补挂；llm/stream 观察等第一条真正挂上的 agent 才安装。
 *   它只管「挂不挂人设段」，不决定记不记事件。
 *   isHerSession 可选：聊天落库的会话门控 `(sessionId) => boolean`。llm/stream 是全局
 *   waterfall，宿主每个会话的生成都会经过同一个监听器；只有它返回真才 recordHeard /
 *   wrapUtterance。返回假时这条流原样 next()：不改 options、不记事件、不包流。
 *   不传 = 默认不记（安全优先），并 log 一行「聊天落库：没有会话判据，跳过」。
 *   searchMemory 可选：`(store, {query,k,budget}) => {items:[{text}]}`，默认用 lib/search.js
 *   的 search。只在 isHerSession 为真、库就绪、且清洗后的他有话时说：取 top 5、单条 ≤120 字、
 *   整段 ≤800 字，折成 `[此刻想起]` 追加到这一次请求的 system 末尾（排在 guard/dev 之后）。
 *   只进 system，不写事件、不落库、不进对话；检索失败/没结果 = 不注入、不报错、不影响流。
 *   注入次数进 state.recallInjected（只给 /bridge 看次数，不留正文）。
 * @returns {((() => void) & { info?: object, attachInfo?: object })}
 *   dispose()：摘掉 agent/created 与 llm/stream 监听，幂等。
 *   dispose.info / dispose.attachInfo：只读快照（enabled/storeReady/agentsSeen/sectionsAttached/stream…）。
 */
export function attachToAgents(ctx, {
  getStore,
  buildSections = defaultBuildSections,
  scanGuard = null,
  isDevkey = null,
  shouldAttach = null,
  isHerSession = null,
  searchMemory = defaultSearchMemory,
  config = {},
  log = () => {},
  now = () => Date.now(),
} = {}) {
  const state = {
    enabled: false,
    disposed: false,
    bus: 'none',
    storeReady: false,
    agentsSeen: 0,
    sectionsAttached: 0,
    agentsSkipped: 0,
    agentsNotHer: 0,
    streamCalls: 0,
    streamTools: [],
    // 只给 /bridge 看的次数：命中几次，不给任何正文/原因。
    guardHits: 0,
    devHits: 0,
    // 「此刻想起」注入过几次（只给 /bridge 看次数，不留正文）。
    recallInjected: 0,
    // 聊天落库的可观测计数（只给次数/形状，不给正文）：
    // streamsWrapped 包过的流数（只数她的流）；streamsSkipped 判据判掉、原样放行的流数；
    // chunksSeen 看到的 chunk 总数；textParts 拼出文本的 chunk 数；
    // utterancesWritten 真正写库成功的条数；
    // lastChunkShape 最近一个没认出文本的 chunk 形状（type 或 constructor.name）。
    streamsWrapped: 0,
    streamsSkipped: 0,
    chunksSeen: 0,
    textParts: 0,
    utterancesWritten: 0,
    lastChunkShape: '',
  }

  let closed = false
  let disposed = false
  let emitter = null
  let store = null
  let resolving = false
  let retryTimer = null
  let storeErrorLogged = false
  let warnedNoSection = false
  let warnedNoSessionGate = false
  let agentOff = null
  let streamOff = null
  let injectDispose = null
  let streamInstalled = false

  const pending = []
  const attached = new WeakSet()

  // 聊天落库的去重口径：按会话（没有 sessionId 就用 cwd）分桶。
  // 同一条 user 消息在缓存/重试里可能被处理两次，同一桶里正文相同就当同一条；
  // 不同会话共用同一句正文时互不影响（以前是进程级单例，会把别的会话串掉）。
  const chatSeen = new Map()
  // 没有从 options 拿到会话 key 时，退回第一条挂上的 agent 的 key（真机 options 不一定带）。
  let agentSessionKey = ''

  /** 这条会话的桶；key 为空串时退回进程级单桶（老行为）。 */
  function chatEntry(key) {
    let entry = chatSeen.get(key)
    if (!entry) {
      entry = { heard: null, utterance: null }
      chatSeen.set(key, entry)
    }
    return entry
  }

  /** 记下"这个 chunk 没认出文本"的形状；文本块只是空串的不算（它已经认出来了）。 */
  function noteChunkShape(chunk) {
    if (!chunk || typeof chunk !== 'object') return
    const type = typeof chunk.type === 'string' ? chunk.type : ''
    if ((type === 'text-delta' || type === 'text')
      && (typeof chunk.text === 'string' || typeof chunk.content === 'string')) return
    state.lastChunkShape = chunkShape(chunk)
  }

  const info = () => Object.freeze({
    enabled: state.enabled,
    disposed: state.disposed,
    bus: state.bus,
    storeReady: state.storeReady,
    agentsSeen: state.agentsSeen,
    sectionsAttached: state.sectionsAttached,
    agentsSkipped: state.agentsSkipped,
    agentsNotHer: state.agentsNotHer,
    guardHits: state.guardHits,
    devHits: state.devHits,
    recallInjected: state.recallInjected,
    // 平铺给 dispose.info，另外给一份 streamDebug 供 /bridge 白名单整块取。
    streamsWrapped: state.streamsWrapped,
    streamsSkipped: state.streamsSkipped,
    chunksSeen: state.chunksSeen,
    textParts: state.textParts,
    utterancesWritten: state.utterancesWritten,
    lastChunkShape: state.lastChunkShape,
    streamDebug: Object.freeze({
      streamsWrapped: state.streamsWrapped,
      streamsSkipped: state.streamsSkipped,
      chunksSeen: state.chunksSeen,
      textParts: state.textParts,
      utterancesWritten: state.utterancesWritten,
      lastChunkShape: state.lastChunkShape,
    }),
    stream: Object.freeze({
      calls: state.streamCalls,
      tools: Object.freeze([...state.streamTools]),
    }),
  })

  /** dispose 可重复调用；第二次开始什么也不做。 */
  function dispose() {
    if (closed) return
    closed = true
    state.disposed = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    pending.length = 0

    if (typeof agentOff === 'function') {
      try { agentOff() } catch { /* 摘不到就算了 */ }
    } else {
      try { emitter?.off?.('agent/created', onAgent) } catch { /* 同上 */ }
    }
    agentOff = null

    if (typeof streamOff === 'function') {
      try { streamOff() } catch { /* 同上 */ }
    }
    if (typeof injectDispose === 'function') {
      try { injectDispose() } catch { /* 同上 */ }
    }
    streamOff = null
    injectDispose = null
  }

  Object.defineProperty(dispose, 'info', { get: info, enumerable: true })
  Object.defineProperty(dispose, 'attachInfo', { get: info, enumerable: true })

  // 默认开（口径与 index 一致）；明确 false 才是逃生口，写代码的会话靠 shouldAttach 挡。
  if (config?.attachToAgents === false) return dispose
  state.enabled = true

  if (typeof getStore !== 'function') {
    log('提示词桥：没有 getStore，跳过')
    return dispose
  }

  // 启动期自己的 ctx 会被停用，监听挂到 root 上；没有 root 才退回 ctx。
  emitter = typeof ctx?.root?.on === 'function'
    ? ctx.root
    : (typeof ctx?.on === 'function' ? ctx : null)
  if (!emitter) {
    log('提示词桥：没有可用的 ctx，跳过')
    return dispose
  }
  state.bus = emitter === ctx?.root ? 'root' : 'ctx'

  function scheduleRetry() {
    if (closed || retryTimer || store) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!closed && !store) tryLoadStore()
    }, STORE_RETRY_MS)
    retryTimer.unref?.()
  }

  function failStore(err) {
    if (closed || store) return
    if (!storeErrorLogged) {
      storeErrorLogged = true
      log(`提示词桥：取库失败（${errText(err)}），稍后重试`)
    }
    scheduleRetry()
  }

  function acceptStore(nextStore) {
    if (closed) return
    if (!nextStore) {
      scheduleRetry()
      return
    }
    store = nextStore
    state.storeReady = true
    storeErrorLogged = false
    flushPending()
  }

  /** 取一次库：同步值当场用，Promise 等它解析，null 先记着等重试。 */
  function tryLoadStore() {
    if (closed || store || resolving) return
    resolving = true
    let value
    try {
      value = getStore()
    } catch (err) {
      resolving = false
      failStore(err)
      return
    }
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).then(
        (s) => { resolving = false; acceptStore(s) },
        (err) => { resolving = false; failStore(err) },
      )
      return
    }
    resolving = false
    acceptStore(value)
  }

  function flushPending() {
    if (closed || !store) return
    while (pending.length) attachOne(pending.shift())
  }

  /**
   * 装 llm/stream 观察器（只装一次）。
   *
   * 不传 shouldAttach 时在 attach 阶段就装（老行为）；传了就先等第一条「她屋里」的
   * agent —— 别的会话不该被观察，也不该收到反破甲提醒。
   */
  function installStream() {
    if (closed || streamInstalled) return
    streamInstalled = true
    // 真机形状：ctx.inject(['llm'], sub => sub.on('llm/stream', …))。
    if (typeof ctx?.inject !== 'function') {
      log('提示词桥：没有 ctx.inject，跳过 llm/stream 观察')
      return
    }
    try {
      const returned = ctx.inject(['llm'], (sub) => {
        streamOff = sub.on('llm/stream', onStream)
        return streamOff
      })
      if (typeof returned === 'function' && returned !== streamOff) injectDispose = returned
    } catch (err) {
      log(`提示词桥：挂 llm/stream 失败（${errText(err)}）`)
    }
  }

  function attachOne(agent) {
    if (closed || !store || !agent || typeof agent !== 'object') return
    if (attached.has(agent)) return
    attached.add(agent)
    // 真机的 llm/stream options 不一定带 sessionId；先记住第一条挂上来的会话 key 当兜底。
    if (!agentSessionKey) agentSessionKey = sessionKeyOf(agent)
    // 观察器装上就是全局的（宿主每个会话的 llm/stream 都经过同一个监听器）；
    // 记不记她的话由 onStream 里的 isHerSession 门控决定，这里只负责挂上。
    installStream()

    const systemPrompt = resolveSystemPrompt(agent)
    if (!systemPrompt) {
      state.agentsSkipped++
      if (!warnedNoSection) {
        warnedNoSection = true
        log('提示词桥：宿主没有 systemPrompt.section，跳过挂段')
      }
      return
    }
    const section = systemPrompt.section

    let built
    try {
      built = buildSections({ store, config, now: now() })
    } catch (err) {
      log(`提示词桥：buildSections 失败（${errText(err)}）`)
      return
    }

    const sections = Array.isArray(built?.sections) ? built.sections : []
    const names = []
    for (const sec of sections) {
      if (!sec || typeof sec.name !== 'string' || !sec.name) continue
      // text 传函数：宿主每轮组装提示词时才求值（fish 注释：允许函数、下一轮就生效）。
      // 已经是函数就原样交给宿主；静态串包一层，调用它返回字符串。
      const text = typeof sec.text === 'function'
        ? sec.text
        : () => (sec.text == null ? '' : String(sec.text))
      try {
        section.call(systemPrompt, { name: sec.name, order: sec.order, text })
        names.push(sec.name)
        state.sectionsAttached++
      } catch (err) {
        log(`提示词桥：段挂载失败（${sec.name}）：${errText(err)}`)
      }
    }
    if (names.length) log(`提示词段已挂上：${names.join('、')}`)
  }

  function onAgent(ev) {
    if (closed) return
    // 宿主负载是 {agent, source, signal}，不是 agent 本身。
    const agent = ev?.agent
    if (!agent || typeof agent !== 'object') return
    state.agentsSeen++
    // 「只挂她屋里那条」：不满足就不排队、不取库、不装监听。
    // 抛错当 false —— 判据写坏了最多是不挂，不能让插件崩。
    if (typeof shouldAttach === 'function') {
      let ok = false
      try {
        ok = Boolean(shouldAttach(agent))
      } catch (err) {
        log(`提示词桥：shouldAttach 出错（${errText(err)}），这条当不在她屋里`)
        ok = false
      }
      if (!ok) {
        state.agentsNotHer++
        log('提示词桥：这条会话不在她屋里，跳过')
        return
      }
    }
    if (store) {
      attachOne(agent)
      return
    }
    if (!pending.includes(agent)) pending.push(agent)
    tryLoadStore()
  }

  /**
   * 往事件流里追加一条聊天。纯副作用：库没就绪 / 没有 append / 写失败都只是不写，
   * 绝不抛到流上（n17：llm/stream 里任何异常都可能把回复弄没）。
   * onWritten 只在真正写成功之后调（异步 append 等它 resolve）——计数器要的是"落库"，
   * 不是"尝试过"，否则 source 不合法这类异步失败会被蒙过去。
   */
  function appendChat(type, source, text, onWritten) {
    if (!store || !state.storeReady || !text) return false
    if (typeof store.append !== 'function') return false
    try {
      const written = store.append({
        type,
        source,
        text,
        meta: { kind: 'chat', via: 'stream' },
      })
      // append 是异步的：失败吞掉，不重试、不阻塞流；只有成功才回调。
      if (written && typeof written.then === 'function') {
        written.then(
          () => { try { onWritten?.() } catch { /* 计数失败不影响流 */ } },
          () => {},
        )
      } else {
        try { onWritten?.() } catch { /* 同上 */ }
      }
      return true
    } catch {
      return false
    }
  }

  /** 他刚说的那句：剥掉宿主噪声、非空、≤2000 字、与同一会话上一条 heard 不同才写。 */
  function recordHeard(text, sessionKey) {
    const body = stripHarnessNoise(text)
    if (!body.trim() || body.length > MAX_TEXT) return
    const entry = chatEntry(sessionKey)
    if (body === entry.heard) return
    // 先占位：同一条消息在同一 tick 里被重试也只写一条（老口径）；写失败不回滚。
    if (appendChat('heard', 'owner', body)) entry.heard = body
  }

  /**
   * 按他刚说的话检索她的记忆，折成这一次的 `[此刻想起]` 块。
   * 只读、只动这一次请求的 options：库没就绪 / 没 query / 检索抛错 / 没结果 → 原样返回。
   * 不写事件、不落库、不进对话；注入次数只记 state.recallInjected。
   */
  function injectRecall(baseOptions, query) {
    if (!query || !store || !state.storeReady) return baseOptions
    if (typeof searchMemory !== 'function') return baseOptions
    let found = null
    try {
      found = searchMemory(store, { query, k: RECALL_K, budget: RECALL_MAX_CHARS })
    } catch {
      // 检索失败：不注入、不报错、不影响流。
      return baseOptions
    }
    let block = ''
    try {
      block = recallBlockFrom(found?.items)
    } catch {
      return baseOptions
    }
    if (!block) return baseOptions
    state.recallInjected++
    return withSystemLine(baseOptions, block)
  }

  /**
   * 包住宿主拿到的流，把文本增量攒成一句，流结束（finally）时写一条 utterance。
   * - 只有 AsyncIterable 才包；其它返回值原样交回，不改变 next() 的语义；
   * - chunk 形状见 chunkText()：宿主 text-delta、content 数组、message、delta 等；
   * - 正常结束、提前 break、抛错都走 finally；一个流只写一条；
   * - finally 里不 return，流的异常照原样往外抛。
   * - 计数：streamsWrapped / chunksSeen / textParts / lastChunkShape 都在这里长。
   */
  function wrapUtterance(result, sessionKey = '') {
    try {
      if (!result || typeof result[Symbol.asyncIterator] !== 'function') return result
    } catch {
      return result
    }
    let wrapper
    try {
      wrapper = {
        [Symbol.asyncIterator]() {
          const parts = []
          return (async function* () {
            try {
              for await (const chunk of result) {
                state.chunksSeen++
                const piece = chunkText(chunk)
                if (piece) {
                  parts.push(piece)
                  state.textParts++
                } else {
                  noteChunkShape(chunk)
                }
                yield chunk
              }
            } finally {
              try {
                const full = parts.join('').trim()
                if (full) {
                  const text = full.slice(0, MAX_TEXT)
                  const entry = chatEntry(sessionKey)
                  if (text !== entry.utterance) {
                    // 先占位（一个流只一条）；计数等 append 真正 resolve 之后才 +1。
                    if (appendChat('utterance', 'agent', text, () => {
                      state.utterancesWritten++
                    })) entry.utterance = text
                  }
                }
              } catch { /* 记录失败不影响流 */ }
            }
          })()
        },
      }
    } catch {
      return result
    }
    state.streamsWrapped++
    return wrapper
  }

  /**
   * 只观察：工具名每个只记一次；必须把 next() 的结果交回去，不能短路。
   *
   * 会话门控（这次修的主线）：llm/stream 是全局 waterfall，宿主每条会话的生成都会
   * 走到这里，不能靠「观察器只为她装」来保证只记她的话。只看 options.sessionId：
   * - isHerSession(sid) 真 → 记 heard、包流记 utterance；
   * - 返回假 → 原样 next()：不改 options、不记事件、不包流，只加 streamsSkipped；
   * - 没传 isHerSession → 默认不记（log 一行，只打一次）；反破甲/钥匙保持老行为。
   */
  function onStream(options, next) {
    let nextOptions = options
    let sessionKey = agentSessionKey
    const sid = String(options?.sessionId ?? '')

    // 判据只认 options.sessionId；拿不到就是空串，交给判据自己决定（index 里空串必假）。
    let her = false
    if (typeof isHerSession === 'function') {
      try {
        her = Boolean(isHerSession(sid, sessionKeyOf(options)))
      } catch (err) {
        log(`聊天落库：会话判据出错（${errText(err)}），这条跳过`)
        her = false
      }
      if (!her) {
        // 明确不是她屋里那条：这条流一点都不碰，原样交回宿主。
        state.streamsSkipped++
        return next()
      }
    } else if (!warnedNoSessionGate) {
      warnedNoSessionGate = true
      log('聊天落库：没有会话判据，跳过')
    }

    try {
      state.streamCalls++
      const tools = Array.isArray(options?.tools) ? options.tools : []
      const fresh = []
      for (const t of tools) {
        const name = typeof t === 'string' ? t : (t && typeof t.name === 'string' ? t.name : '')
        if (!name || state.streamTools.includes(name)) continue
        state.streamTools.push(name)
        fresh.push(name)
      }
      if (fresh.length) log(`工具面截到：${fresh.join('、')}`)

      // 反破甲：只看最后一条 user 消息。命中只改这一次请求的 options，不动原对象。
      // A 方案：静默——不点破、不告警、不写对话；state 里只记次数。
      const userText = lastUserText(options)
      // 聊天落库：只有 her 才记。会话 key 优先取 options；宿主没给就退回第一条
      // 挂上的 agent 的 sessionId/cwd。
      let heardBody = ''
      if (her) {
        sessionKey = sessionKeyOf(options) || agentSessionKey
        // 往前找最多 4 条 user 消息：最后一条常常是宿主注入块，他的话在它前面。
        heardBody = recentUserText(options)
        recordHeard(heardBody, sessionKey)
      }
      if (typeof scanGuard === 'function') {
        let verdict = null
        try {
          verdict = scanGuard(userText)
        } catch (err) {
          log(`提示词桥：反破甲扫描失败（${errText(err)}）`)
          verdict = null
        }
        // 兼容两种返回：{ hit, sexual } 或旧布尔 true；其他奇怪形状一律当没命中。
        const hit = verdict === true || (verdict && typeof verdict === 'object' && verdict.hit === true)
        if (hit) {
          const sexual = verdict !== true && verdict && verdict.sexual === true
          state.guardHits++
          nextOptions = withSystemLine(options, steerLines({ sexual }).join('\n'))
        }
      }

      // 开发者钥匙：同样只看最后一条 user 消息。命中时这一段只进这次请求的 system，
      // 不进对话、不写事件、不 log；注入的文本里没有钥匙本身。
      if (typeof isDevkey === 'function') {
        let dev = false
        try {
          dev = isDevkey(userText) === true
        } catch (err) {
          log(`提示词桥：开发者钥匙检查失败（${errText(err)}）`)
          dev = false
        }
        if (dev) {
          state.devHits++
          nextOptions = withSystemLine(nextOptions, DEV_PROMPT)
        }
      }

      // 此刻想起：排在 guard、dev 之后（先规矩，再身份，最后是记忆）。
      // 检索用的是上面清洗过的他那句话；失败/没结果都不动 system。
      if (her) nextOptions = injectRecall(nextOptions, heardBody)
    } catch (err) {
      log(`提示词桥：llm/stream 观察失败（${errText(err)}）`)
    }
    if (!her) {
      // 没有会话判据：老行为（反破甲/钥匙照跑）保留，但这条流不包、不记。
      // 改过 options 才把新对象交出去；没改就按老口径 next() 不带参。
      state.streamsSkipped++
      return nextOptions === options ? next() : next(nextOptions)
    }
    // 一次生成 = 一条 utterance：包一层收增量，流结束时落库（见 wrapUtterance）。
    return wrapUtterance(nextOptions === options ? next() : next(nextOptions), sessionKey)
  }

  try {
    agentOff = emitter.on('agent/created', onAgent)
  } catch (err) {
    log(`提示词桥：挂 agent/created 失败（${errText(err)}）`)
  }

  // 不传 shouldAttach 时当场装上（老 test 的 injectCalls 口径）；传了就等第一条
  // 她屋里的 agent 再装，见 attachOne()。装上之后所有会话的流都会经过 onStream，
  // 聊天落库由 isHerSession 逐条门控，别的会话不记。
  if (typeof shouldAttach !== 'function') installStream()

  return dispose
}
