// 双流（M9）：A 暗栏 / B 顺序。默认关。
//
// 三条硬约束（知识库 n10 / n11 / n18）：
// 1. `llm/stream` 是 cordis waterfall：监听器必须**同步**返回 AsyncIterable；
//    返回 undefined / Promise 会让宿主拿到空流或把 stream() 变成 Promise。
// 2. 监听器里再调 `llm.stream()` 会重进同一条瀑布，必须用同步 depth 护栏；
//    护栏要包住**整个迭代过程**（async generator 的 body 是迭代时才跑的）。
// 3. `want/blockedBy/line` 是自述句，模型会把它当台词念。渲染文案必须写死
//    "这一段一个字都不许出现在回答里"，并且不复述、不提"先算/约束/草稿"。
//
// A 档：一次生成。system 里加"先写草稿，--- 之后才是台词"，流里剥掉 --- 之前；
//        没有 --- 就整段放行（不吞她的话）；剥完只剩空白才回吐兜底。
// B 档：只在触发时多跑一次 R（只回 JSON 约束），把约束并进 E 的 system；
//        普通闲聊不升级。任何一步失败都退回单次。
export const DEFAULT_DUAL = Object.freeze({
  enabled: false,
  mode: 'A',
  strip: true,
  planMaxTokens: 220,
  cacheTTL: 5 * 60 * 1000,
  cacheMax: 32,
  triggerChars: 400,
  requireTools: true,
})

/** 剥完暗栏后什么都不剩时，至少回一句，别让调用方拿到空流。 */
export const FALLBACK_TEXT = '（嗯。）'

/** A 档的草稿指令。`---` 单独一行是唯一的分隔符。 */
export const DRAFT_INSTRUCTION = [
  '开口之前先写一小段草稿：你打算怎么接、要避开什么。',
  '草稿写完后，单独一行写 ---，再写你真正要说出口的话。',
  '--- 之前的草稿不会给任何人看；没有写 ---，就当你没写草稿。',
].join('\n')

/**
 * R（先算）的 system。只回一个 JSON，不写台词。
 * `line` 必须是动作短语：只写"想要/我要"会坍缩成同一个"先确认"（n18）。
 */
export const PLAN_SYSTEM = [
  '你在替一个人先想清楚，再让她开口。只输出一个 JSON 对象，不要解释，不要代码块。',
  '格式：{"want":"这一句里她真正想要的（不超过20字）","blockedBy":"挡住她的是什么（不超过20字，没有就空字符串）","line":"下一步的具体动作（3-8字，动作短语，不是句子）"}',
  '"line" 只写动作，不写“我想／我要／先算”这类自述。三个不同的样子：问他去哪了 / 不提那件事 / 去门口等。同一段对话里别反复用同一个动作词。',
  '只针对最后一条用户消息。',
].join('\n')

/** B 档触发词表：拒绝 / 边界 / 关系 / 自我怀疑 / 前后矛盾。 */
export const TRIGGERS = Object.freeze({
  refusal: Object.freeze([
    '拒绝', '我不想', '我不去', '我不要', '不能', '不行', '不可以',
    '不愿意', '不答应', '不原谅', '不回去', '不回来',
    '别再', '别问', '别管', '别碰', '别说了', '够了', '停下', '住手',
  ]),
  boundary: Object.freeze([
    '边界', '越界', '隐私', '我的事', '不用你管', '轮不到你',
    '适可而止', '过分了', '你不要管',
  ]),
  relation: Object.freeze([
    '关系', '爱你', '想你', '等你', '离开', '分手', '结婚', '在一起',
    '原谅', '背叛', '信任', '朋友', '家人', '舍不得', '陪着我',
    '不要走', '要走了', '走了', '不回来',
  ]),
  doubt: Object.freeze([
    '我是不是', '我到底', '是不是我', '我不够', '我没用', '我错了',
    '我该不该', '我配', '值得吗', '为什么是我', '我不好', '我是不是太',
  ]),
  contradiction: Object.freeze([
    '但是', '可是', '之前说', '你不是说', '刚才', '明明',
    '又说', '矛盾', '一会儿', '说好', '答应过', '却',
  ]),
})

const errText = (err) => String(err?.message ?? err ?? '未知错误')
const round3 = (n) => Math.round(Number(n) * 1e3) / 1e3

/** 这一段用户消息要不要升级到 B 档。普通闲聊不升级。 */
export function needsPlan(text, cfg = {}) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  const max = Number(cfg?.triggerChars)
  if (s.length > (Number.isFinite(max) && max >= 0 ? max : DEFAULT_DUAL.triggerChars)) return true
  for (const list of Object.values(TRIGGERS)) {
    for (const word of list) if (s.includes(word)) return true
  }
  return false
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

/** 最后一条 role:'user' 消息的文本。 */
function lastUserText(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') return contentText(m.content)
  }
  return ''
}

function sessionIdOf(options) {
  for (const key of ['sessionId', 'sessionID', 'conversationId', 'threadId']) {
    const v = options?.[key]
    if (typeof v === 'string' && v) return v
  }
  if (typeof options?.session === 'string' && options.session) return options.session
  if (typeof options?.session?.id === 'string' && options.session.id) return options.session.id
  return ''
}

/** 同一会话 + 同一句用户消息，一轮里只"先算"一次。 */
function cacheKey(options, user) {
  const sid = sessionIdOf(options)
  if (!sid && !user) return ''
  return `${sid}\u0000${user}`
}

/** 把一段提示接进 system；没有 system 才退回 promptPrefix。不改原对象（会被 deepFreeze）。 */
function withSystemBlock(options, block) {
  const base = options || {}
  if (typeof base.system === 'string') {
    return { ...base, system: base.system ? `${base.system}\n\n${block}` : block }
  }
  if (base.system !== undefined && base.system !== null) {
    return { ...base, system: `${String(base.system)}\n\n${block}` }
  }
  const prefix = typeof base.promptPrefix === 'string' ? base.promptPrefix : ''
  return { ...base, promptPrefix: prefix ? `${prefix}\n\n${block}` : block }
}

/**
 * 把 R 的约束渲染成 E 的 system 段。
 * 口径（n18）：这是"心里过的账"，不是台词；出现「想要／挡住／打算」就算没做到。
 */
export function renderConstraints(plan) {
  if (!plan || typeof plan !== 'object') return ''
  const want = String(plan.want ?? '').trim()
  const blockedBy = String(plan.blockedBy ?? '').trim()
  const line = String(plan.line ?? '').trim()
  if (!want && !blockedBy && !line) return ''

  const rows = [
    '你自己心里已经过了一遍这件事。下面这段只给你自己看，不是要说出口的话。',
  ]
  if (want) rows.push(`想要：${want}`)
  if (blockedBy) rows.push(`挡住：${blockedBy}`)
  if (line) rows.push(`打算：${line}`)
  rows.push('这一段一个字都不许出现在回答里；回答里出现「想要」「挡住」「打算」任一个词，就算没做到。')
  rows.push('不要复述这段话，也不要提「先算」「约束」「草稿」这类词。照着它约束自己，然后用你自己的话说。')
  return rows.join('\n')
}

function asPlan(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const parts = ['want', 'blockedBy', 'line'].filter(
    (key) => typeof obj[key] === 'string' && obj[key].trim(),
  )
  if (!parts.length) return null
  return {
    want: typeof obj.want === 'string' ? obj.want : '',
    blockedBy: typeof obj.blockedBy === 'string' ? obj.blockedBy : '',
    line: typeof obj.line === 'string' ? obj.line : '',
    parts,
  }
}

/** 先试非贪婪的第一个 JSON，再试贪婪的整段（模型偶尔会包一层说明）。 */
function parsePlan(raw) {
  const s = String(raw ?? '').replace(/```(?:json)?/gi, '').trim()
  if (!s) return null
  const candidates = []
  const first = /\{[\s\S]*?\}/.exec(s)
  if (first) candidates.push(first[0])
  const whole = /\{[\s\S]*\}/.exec(s)
  if (whole && whole[0] !== first?.[0]) candidates.push(whole[0])
  for (const candidate of candidates) {
    try {
      const plan = asPlan(JSON.parse(candidate))
      if (plan) return plan
    } catch { /* 试下一个 */ }
  }
  return null
}

function normalizePlan(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const direct = asPlan(value)
    if (direct) return direct
    if (typeof value.text === 'string') return parsePlan(value.text)
  }
  return parsePlan(String(value ?? ''))
}

/**
 * 读一条流里的可见文本。chunk 形状：
 * block-start / text-delta{index,text} / reasoning-delta / block-end{block.text} / usage / finish
 *
 * block-end 会再给一次整块全文，容易把文本加两遍：等于已收内容就丢、startsWith 就替换、
 * 否则补尾巴（M9 的两个真 bug 之一）。
 */
async function collectText(stream) {
  let text = ''
  const types = {}
  let usage = null
  let finish = null
  for await (const chunk of stream) {
    const type = String(chunk?.type ?? 'unknown')
    types[type] = (types[type] ?? 0) + 1
    if (type === 'text-delta') {
      text += String(chunk.text ?? '')
    } else if (type === 'block-end') {
      const whole = typeof chunk?.block?.text === 'string' ? chunk.block.text : ''
      if (whole) {
        if (whole === text) { /* 已经收过 */ }
        else if (whole.startsWith(text)) text = whole
        else if (!text.startsWith(whole)) text += whole
      }
    } else if (type === 'usage') {
      usage = chunk
    } else if (type === 'finish') {
      finish = chunk.reason ?? chunk.finish ?? null
    }
  }
  return { text, types, usage, finish }
}

/** 找独占一行的 `---`，返回分隔符之后的下标；没有就返回 -1。 */
function findCut(text) {
  const m = /(^|\n)[ \t]*---[ \t]*\r?(?=\n|$)/.exec(text)
  if (!m) return -1
  let end = m.index + m[0].length
  if (text[end] === '\r') end += 1
  if (text[end] === '\n') end += 1
  return end
}

function rewriteBlock(chunk, text) {
  const block = chunk?.block
  if (!block || typeof block !== 'object') return chunk
  return { ...chunk, block: { ...block, text } }
}

/**
 * A 档的流过滤器：先攒 text-delta，看到独占一行的 `---` 才放；没有就整段放行。
 * 超过 4000 字也不再等（暗栏不该把一句话卡成整段）。
 */
async function* stripDraft(stream, { fallback = FALLBACK_TEXT, maxWait = 4000, now = Date.now, log = () => {} } = {}) {
  const startedAt = now()
  let buffer = ''
  let original = ''
  let kept = ''
  let chunks = 0
  let decided = false
  let stripped = false
  let usage = null

  for await (const chunk of stream) {
    chunks++
    const type = chunk?.type

    if (type === 'text-delta') {
      const piece = String(chunk.text ?? '')
      original += piece
      if (decided) {
        kept += piece
        yield chunk
        continue
      }
      buffer += piece
      const cut = findCut(buffer)
      if (cut >= 0) {
        // 分隔符正好落在这一块的末尾：先等下一块，免得把紧跟其后的换行当正文放出去。
        const pendingNewline = cut === buffer.length && !buffer.endsWith('\n')
        if (!pendingNewline) {
          decided = true
          stripped = true
          const tail = buffer.slice(cut)
          buffer = ''
          if (tail) {
            kept += tail
            yield { ...chunk, text: tail }
          }
        }
      } else if (buffer.length > maxWait) {
        decided = true
        const all = buffer
        buffer = ''
        if (all) {
          kept += all
          yield { ...chunk, text: all }
        }
      }
      continue
    }

    if (type === 'block-end') {
      const whole = typeof chunk?.block?.text === 'string' ? chunk.block.text : ''
      if (!decided && whole) {
        const cut = findCut(whole)
        if (cut >= 0) {
          decided = true
          stripped = true
          const tail = whole.slice(cut)
          buffer = ''
          if (tail) {
            kept += tail
            yield { type: 'text-delta', index: chunk?.block?.index ?? 0, text: tail }
          }
          yield rewriteBlock(chunk, tail)
        } else {
          decided = true
          if (buffer) {
            kept += buffer
            yield { type: 'text-delta', index: 0, text: buffer }
            buffer = ''
          }
          yield chunk
        }
        continue
      }
      if (stripped && whole) {
        const cut = findCut(whole)
        yield rewriteBlock(chunk, cut >= 0 ? whole.slice(cut) : whole)
        continue
      }
      yield chunk
      continue
    }

    if (type === 'usage') usage = chunk
    yield chunk
  }

  if (!decided) {
    decided = true
    const cut = findCut(buffer)
    if (cut >= 0) {
      // 流在 `---` 后就结束了：这里补做一次决定，别把分隔符当正文。
      stripped = true
      const tail = buffer.slice(cut)
      buffer = ''
      if (tail) {
        kept += tail
        yield { type: 'text-delta', index: 0, text: tail }
      }
    } else if (buffer) {
      // 没有分隔符：整段放行，不吞话。
      kept += buffer
      yield { type: 'text-delta', index: 0, text: buffer }
      buffer = ''
    }
  }

  // 剥完只剩空白（或者只有分隔符）：回吐一句兜底，不要给调用方空流。
  if (stripped && kept.trim() === '') {
    kept += fallback
    yield { type: 'text-delta', index: 0, text: fallback }
  }

  const usageStr = usage ? ` / usage ${JSON.stringify(usage)}` : ''
  log(`双流A：${now() - startedAt}ms / ${chunks} 块 / 原文 ${original.length} 字 → 留 ${kept.length} 字 / 草稿${stripped ? '有' : '无'}${usageStr}`)
}

/** R 只带最近 6 条消息，且不带 tools（否则它会去调工具、0 字）。 */
function planOptions(options, cfg) {
  const { tools, toolChoice, ...rest } = options || {}
  const messages = Array.isArray(rest.messages) ? rest.messages.slice(-6) : []
  return {
    ...rest,
    system: PLAN_SYSTEM,
    messages,
    maxTokens: Number(cfg?.planMaxTokens) || DEFAULT_DUAL.planMaxTokens,
    temperature: 0.2,
  }
}

/**
 * 双流监听器本体。导出是为了单测和探针能直接喂假 waterfall；
 * 正常装配用下面的 attachDual。
 *
 * @param {object} opts
 * @param {object|Function} opts.llm LLM 服务（对象或返回对象的 getter）
 * @param {boolean} [opts.enabled]
 * @param {'A'|'B'} [opts.mode]
 * @param {object} [opts.cfg] DEFAULT_DUAL 的覆盖
 * @param {Function} [opts.plan] 注入的 R（prompt → JSON 字符串/对象），默认走 llm.stream
 * @param {Function} [opts.log]
 * @param {Function} [opts.now]
 */
export function makeDualListener({
  llm,
  enabled = false,
  mode = 'A',
  cfg = {},
  plan,
  deps,
  log = () => {},
  now,
} = {}) {
  const conf = { ...DEFAULT_DUAL, ...(cfg || {}) }
  const resolvedMode = String(mode || conf.mode || 'A').toUpperCase() === 'B' ? 'B' : 'A'
  const clock = typeof now === 'function'
    ? now
    : (typeof conf.now === 'function' ? conf.now : () => Date.now())
  const cache = new Map()
  const statsState = {
    plans: 0,
    cacheHits: 0,
    fallbacks: 0,
    planMs: 0,
    lastAt: null,
  }
  let depth = 0

  const stats = () => Object.freeze({
    mode: resolvedMode,
    plans: statsState.plans,
    cacheHits: statsState.cacheHits,
    fallbacks: statsState.fallbacks,
    seconds: round3(statsState.planMs / 1000),
    lastAt: statsState.lastAt,
  })

  const llmOf = () => (typeof llm === 'function' ? llm() : llm)
  function streamOf(options) {
    const service = llmOf()
    if (!service || typeof service.stream !== 'function') throw new Error('没有 llm.stream')
    const stream = service.stream(options)
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('llm.stream 没有返回 AsyncIterable')
    }
    return stream
  }

  /** 护栏：depth 包住整个迭代，而不只是创建。 */
  function guarded(make) {
    depth += 1
    let stream
    try {
      stream = make()
    } catch (err) {
      depth -= 1
      throw err
    }
    return (async function* holdDepth() {
      try {
        yield* stream
      } finally {
        depth -= 1
      }
    })()
  }

  function cacheGet(key) {
    if (!key) return null
    const hit = cache.get(key)
    if (!hit) return null
    if (clock() - hit.at >= conf.cacheTTL) {
      cache.delete(key)
      return null
    }
    // 写时 delete + set 保序；命中只续位置，不续时间（TTL 从第一次算起）。
    cache.delete(key)
    cache.set(key, hit)
    return hit.plan
  }

  function cacheSet(key, value) {
    if (!key) return
    cache.delete(key)
    cache.set(key, { plan: value, at: clock() })
    while (cache.size > Math.max(1, Number(conf.cacheMax) || DEFAULT_DUAL.cacheMax)) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  async function runPlan(user, options) {
    const planner = plan ?? deps?.plan ?? conf.plan ?? conf.deps?.plan
    if (typeof planner === 'function') return normalizePlan(await planner(user, options))
    const stream = guarded(() => streamOf(planOptions(options, conf)))
    const got = await collectText(stream)
    if (got.text && !got.text.trim()) log('双流B·先算：拿到空白')
    return normalizePlan(got.text)
  }

  function aStream(options, next) {
    return (async function* runA() {
      let stream
      try {
        stream = guarded(() => streamOf(withSystemBlock(options, DRAFT_INSTRUCTION)))
      } catch (err) {
        log(`双流A：挂不上暗栏，退回单次（${errText(err)}）`)
        yield* next()
        return
      }
      if (conf.strip === false) {
        yield* stream
        return
      }
      yield* stripDraft(stream, { now: clock, log })
    })()
  }

  function bStream(options, next) {
    return (async function* runB() {
      const user = lastUserText(options)
      const key = cacheKey(options, user)
      let resolved = cacheGet(key)
      let fromCache = Boolean(resolved)

      if (fromCache) {
        statsState.cacheHits += 1
        statsState.lastAt = clock()
        log('双流B·先算：复用上一轮的约束 → 有约束')
      } else {
        const startedAt = clock()
        statsState.plans += 1
        try {
          resolved = await runPlan(user, options)
          if (!resolved) throw new Error('约束解析失败')
          cacheSet(key, resolved)
        } catch (err) {
          statsState.planMs += Math.max(0, clock() - startedAt)
          statsState.lastAt = clock()
          statsState.fallbacks += 1
          log(`双流B·先算：没约束，退回单次（${errText(err)}）`)
          yield* next()
          return
        }
        statsState.planMs += Math.max(0, clock() - startedAt)
        statsState.lastAt = clock()
        log('双流B·先算：有约束')
      }

      const block = renderConstraints(resolved)
      if (!block) {
        statsState.fallbacks += 1
        log('双流B·约束为空，退回单次')
        yield* next()
        return
      }

      let started = false
      try {
        const stream = guarded(() => streamOf(withSystemBlock(options, block)))
        for await (const chunk of stream) {
          started = true
          yield chunk
        }
      } catch (err) {
        if (started) {
          // 已经吐出过字，再跑一遍会重复；收尾即可，不让回复卡住。
          statsState.fallbacks += 1
          log(`双流B·第二段中断，已停（${errText(err)}）`)
          return
        }
        statsState.fallbacks += 1
        log(`双流B·第二段失败，退回单次（${errText(err)}）`)
        yield* next()
      }
    })()
  }

  /** waterfall 监听器：必须同步返回。 */
  function listener(options, next) {
    if (depth > 0) return next()
    if (!enabled) return next()
    if (resolvedMode === 'B') {
      // 默认只给真实 agent 调用升级：标题生成这类请求没有 tools，即使带了
      // "离开/关系"之类的词也不该白跑一次先算。cfg.requireTools:false 恢复旧行为。
      if (conf.requireTools !== false && !((options?.tools?.length ?? 0) > 0)) return next()
      const user = lastUserText(options)
      if (!needsPlan(user, conf)) return next()
      return bStream(options, next)
    }
    return aStream(options, next)
  }

  listener.stats = stats
  return listener
}

/**
 * 把双流挂到宿主上。只负责注册与统计；ctx 由 index.js 给。
 *
 * @param {object} ctx 宿主上下文
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=false] 只有 true 才注册监听
 * @param {'A'|'B'} [opts.mode='A']
 * @param {object} [opts.cfg] DEFAULT_DUAL 的覆盖
 * @param {Function} [opts.log]
 * @returns {() => void} dispose；dispose.stats() → {mode, plans, cacheHits, fallbacks, seconds, lastAt}
 */
export function attachDual(ctx, {
  enabled = false,
  mode = 'A',
  cfg = {},
  log = () => {},
} = {}) {
  const conf = { ...DEFAULT_DUAL, ...(cfg || {}) }
  const resolvedMode = String(mode || conf.mode || 'A').toUpperCase() === 'B' ? 'B' : 'A'
  let llmRef = null
  const listener = makeDualListener({
    llm: () => llmRef,
    enabled: enabled === true,
    mode: resolvedMode,
    cfg: conf,
    deps: cfg?.deps,
    log,
  })

  let disposed = false
  let off = null
  let injectDispose = null

  function dispose() {
    if (disposed) return
    disposed = true
    if (typeof off === 'function') {
      try { off() } catch { /* 摘不到就算了 */ }
    }
    off = null
    if (typeof injectDispose === 'function') {
      try { injectDispose() } catch { /* 同上 */ }
    }
    injectDispose = null
  }
  dispose.stats = listener.stats

  // 默认关：连监听都不注册。
  if (enabled !== true) return dispose

  if (!ctx || typeof ctx.inject !== 'function') {
    log('双流：没有 ctx.inject，跳过')
    return dispose
  }

  try {
    const returned = ctx.inject(['llm'], (sub) => {
      llmRef = sub?.llm
        ?? (typeof sub?.get === 'function' ? sub.get('llm') : null)
        ?? ctx?.llm
        ?? null
      if (!llmRef) log('双流：子 ctx 没有 llm，先算会退回单次')
      off = sub.on('llm/stream', listener)
      return off
    })
    if (typeof returned === 'function' && returned !== off) injectDispose = returned
    else if (returned && typeof returned.dispose === 'function') injectDispose = () => returned.dispose()
    log(`双流已挂上：${resolvedMode} 档`)
    log('双流挂载点：inject(llm) 子 ctx')
  } catch (err) {
    log(`双流：挂载失败（${errText(err)}）`)
  }

  return dispose
}
