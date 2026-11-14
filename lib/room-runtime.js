// 客厅运行时：把 runRoom / welcome / teaching 接到宿主 llm 上。
//
// 只在 attach 判定「她屋里那条会话 + setup.room」时调用；不建 session。
// 普通客厅输出由 attach 包一层落一条 utterance；只有 welcome 3 连标 noRecord，
// 不写事件、不存正文。子调用带 __piscesRoom，attach 看到就原样 next()，防递归/防落库。
import { markRoomWelcomeSent, needsRoomWelcome } from './setup.js'
import { runRoom } from './room-run.js'
import { lessonText } from './room.js'
import { ROOM_LOCKED_LINE } from './room-invite.js'
import { stripHarnessNoise } from './noise.js'
import { roomReminderMessages } from './welcome.js'

// 客厅一轮的总时限：宿主在等这个 generator，超时后必须自己收尾，
// 否则整个会话（包括别的会话的 UI）会一起卡在“深度思考/加载历史”。
const ROOM_TIMEOUT_MS = 25_000

// 单次子调用（虚拟模型调用）的时限。总时限兜不住“卡在某一次调用里”的情况：
// 那一层 await 不落地，withTimeout 也只能干等。所以每次调用自己带 AbortSignal，
// 到点 abort，让宿主适配器按它的约定尽快收尾。
const ROOM_CALL_TIMEOUT_MS = 12_000

function withTimeout(promise, ms, label) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ text: '', teaching: null, calls: 0, error: label }), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const errText = (err) => String(err?.message ?? err ?? '未知错误')

// 子调用期间置真，attach 看到就原样 next()。不能用 __piscesRoom 字段：
// 那个字段会跟着 options 进到宿主模型请求里，宿主会以 finish:error 结束。
// 除了同步计数，再给子调用的 options 盖一个 symbol（不进 JSON、不进模型请求）：
// 宿主把 waterfall 分发推迟到 await 之后时，同步计数可能已经落回去了。
const ROOM_CALL = Symbol.for('dsh-pisces.room-call')
let roomCallDepth = 0
export function isRoomCall(options) {
  return roomCallDepth > 0 || Boolean(options && options[ROOM_CALL] === true)
}

function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk
  if (!chunk || typeof chunk !== 'object') return ''
  const type = typeof chunk.type === 'string' ? chunk.type : ''
  if (type && type !== 'text-delta' && type !== 'text') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.content === 'string') return chunk.content
  if (typeof chunk.delta?.text === 'string') return chunk.delta.text
  return ''
}

/**
 * 给一次子调用做「外层 signal 或 超时」的合并 signal。
 *
 * 宿主约定 AbortSignal 触发后要尽快收尾；到点我们主动 abort，
 * 免得这一轮永远挂在一个不落地的 await 上（客厅一卡、整个宿主跟着卡）。
 */
function linkAbort(outer, ms) {
  if (typeof AbortController !== 'function') return { signal: outer, timedOut: () => false, done() {} }
  const controller = new AbortController()
  let timedOut = false
  const forward = () => {
    try { controller.abort(outer?.reason) } catch { try { controller.abort() } catch { /* 已经中止 */ } }
  }
  let listening = false
  if (outer && typeof outer.addEventListener === 'function') {
    if (outer.aborted) forward()
    else {
      outer.addEventListener('abort', forward, { once: true })
      listening = true
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    try { controller.abort(new Error('客厅子调用超时')) } catch { try { controller.abort() } catch { /* 同上 */ } }
  }, ms)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done() {
      clearTimeout(timer)
      if (listening) {
        try { outer.removeEventListener('abort', forward) } catch { /* 摘不到就算了 */ }
      }
    },
  }
}

async function collect(stream, debug = {}) {
  if (!stream) {
    debug.kind = 'null'
    return ''
  }
  let text = ''
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    debug.kind = 'async'
    let n = 0
    for await (const chunk of stream) {
      if (n === 0) {
        debug.firstTag = chunk && typeof chunk === 'object' && typeof chunk.type === 'string' ? chunk.type : ''
        debug.firstKeys = chunk && typeof chunk === 'object' ? Object.keys(chunk).slice(0, 10).join(',') : typeof chunk
        debug.firstReason = chunk && typeof chunk === 'object' && chunk.reason != null
          ? (typeof chunk.reason === 'object'
            ? String(chunk.reason.type || chunk.reason.kind || JSON.stringify(chunk.reason).slice(0, 40))
            : String(chunk.reason))
          : ''
      }
      // finish 带 reason.failure 时把错误码/消息也记下来：宿主拒调用时只看
      // kind=error 是判不出原因的（n194：两次子调用都在 1ms 内被 finish:error 打回）。
      if (chunk && typeof chunk === 'object' && chunk.type === 'finish' && chunk.reason && typeof chunk.reason === 'object') {
        const failure = chunk.reason.failure && typeof chunk.reason.failure === 'object' ? chunk.reason.failure : null
        debug.finishKind = String(chunk.reason.kind || chunk.reason.type || '')
        if (failure) {
          debug.failureCode = String(failure.code || '')
          debug.failureMessage = String(failure.message || '').slice(0, 200)
        }
      }
      n += 1
      text += chunkText(chunk)
    }
    debug.chunks = n
    return text
  }
  if (Array.isArray(stream)) {
    debug.kind = 'array'
    debug.chunks = stream.length
    return stream.map(chunkText).join('')
  }
  if (typeof stream === 'string') {
    debug.kind = 'string'
    debug.chunks = 1
    return stream
  }
  debug.kind = typeof stream
  return ''
}

function textStream(text, { noRecord = false } = {}) {
  const it = (async function* () {
    // 宿主 v4 的 text-delta 必须带 index（非负安全整数），否则整轮判失败。
    if (text) yield { type: 'text-delta', index: 0, text }
  })()
  if (noRecord) it.__piscesNoRecord = true
  return it
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue
    const c = list[i].content
    const raw =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('')
          : ''
    // 宿主注入块不是他说的：日志和门票都只用剥干净的这句（n100 的清洗器）。
    return stripHarnessNoise(raw).trim().slice(0, 800)
  }
  return ''
}

/**
 * @param {{
 *   llm?: { stream: Function } | null,
 *   getLlm?: () => { stream: Function } | null,
 *   getSetup: () => object | null,
 *   saveSetup?: (setup: object) => void,
 *   getStore?: () => object | null,
 *   fishSystem?: string | (() => string),
 *   piscesSystem?: string | (() => string),
 *   log?: (message: string) => void,
 * }} deps
 */
export function createRoomRuntime({
  llm = null,
  getLlm = null,
  getSetup,
  saveSetup = null,
  getStore = null,
  // 客厅门票：去客厅要通行码；回来不用（各自家里说「我回来了」）。
  // { consume(text) -> bool, open() , active() -> bool }；不给就不设门。
  roomTicket = null,
  fishSystem = '',
  piscesSystem = '',
  onTurn = null,
  writeTrace = null,
  callTimeoutMs = ROOM_CALL_TIMEOUT_MS,
  turnTimeoutMs = ROOM_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const state = {
    roomCalls: 0,
    welcomes: 0,
    teachings: 0,
    errors: 0,
    lastError: '',
    lastText: '',
    lastStreamKind: '',
    lastChunkTag: '',
    lastChunkKeys: '',
    lastChunks: 0,
    lastFinishReason: '',
    lastMsgCount: 0,
    lastMsgLastRole: '',
    lastSystemLen: 0,
    lastSystemHead: '',
    // 卡在哪一步：'fish' / 'monitor' / 'again' / 'pisces'；空串 = 当前没在子调用里。
    // 卡住时看 phase + phaseAt 就知道是"没开始"还是"卡在第几步"（n193 的下一层）。
    phase: '',
    phaseAt: 0,
    callIndex: 0,
    lastCallKind: '',
    lastCallMs: 0,
    lastCallTextLen: 0,
    lastCallError: '',
    lastTurnMs: 0,
    // 宿主把子调用打回时用的错误码/消息（只看错误，不含正文）。
    lastFailureCode: '',
    lastFailureMessage: '',
    lastProvider: '',
    lastOptionsKeys: '',
  }

  const systemOf = (v) => {
    try {
      return typeof v === 'function' ? String(v() ?? '') : String(v ?? '')
    } catch {
      return ''
    }
  }

  /**
   * 留痕：把「现在卡在哪一步」写到磁盘（index.js 给的是 <root>/room/last-turn.json）。
   * 宿主整个卡死时 /state 也读不到，重启后内存计数又清零——只有落盘的这一步能事后看见。
   * 只写阶段 / 时长 / 错误，不写任何正文。
   */
  function trace(patch) {
    if (typeof writeTrace !== 'function') return
    try { writeTrace({ ...patch, at: Date.now() }) } catch { /* 留痕失败不影响客厅 */ }
  }

  function saveNextSetup(setup) {
    if (typeof saveSetup !== 'function') return
    try { saveSetup(setup) } catch (err) { log(`客厅：保存 setup 失败（${errText(err)}）`) }
  }

  function writeTeaching(lesson, text) {
    const store = typeof getStore === 'function' ? getStore() : null
    if (!store || typeof store.append !== 'function' || !lesson) return
    try {
      const written = store.append({
        type: 'teaching',
        source: 'agent',
        text: text || lessonText(lesson),
        meta: { kind: 'teaching', lessonId: lesson.id, via: 'room' },
      })
      if (written && typeof written.then === 'function') written.catch(() => {})
      state.teachings++
    } catch (err) {
      log(`客厅：写 teaching 失败（${errText(err)}）`)
    }
  }

  const resolveLlm = () => {
    try {
      return typeof getLlm === 'function' ? getLlm() : llm
    } catch {
      return null
    }
  }

  async function callModel(system, messages, baseOptions, kind = '') {
    const client = resolveLlm()
    if (!client || typeof client.stream !== 'function') throw new Error('客厅没有 llm.stream')
    const startedAt = Date.now()
    const guard = linkAbort(baseOptions?.signal, callTimeoutMs)
    const provider = String(baseOptions?.provider || '')
    const model = String(baseOptions?.model || '')
    const options = {
      ...baseOptions,
      system,
      messages,
    }
    // 宿主 dsh-llm 的 forAdapter() 会读 `message.source.replayState`：
    // assistant 消息没有 source 就直接抛 "Cannot read properties of undefined (reading 'replayState')"，
    // 子调用 1ms 内被 finish:error 打回（n194 真机实测）。我们自己拼的历史/台词都没有 source，补上。
    if (provider && model && Array.isArray(options.messages)) {
      options.messages = options.messages.map((m) => (m && m.role === 'assistant' && !m.source
        ? { ...m, source: { kind: 'model', provider, model } }
        : m))
    }
    if (guard.signal) options.signal = guard.signal
    state.phase = kind || 'call'
    state.phaseAt = startedAt
    state.callIndex += 1
    state.lastCallKind = state.phase
    state.lastCallError = ''
    state.lastMsgCount = Array.isArray(options.messages) ? options.messages.length : 0
    state.lastMsgLastRole = Array.isArray(options.messages) && options.messages.length
      ? String(options.messages[options.messages.length - 1]?.role || '')
      : ''
    state.lastSystemLen = String(options.system || '').length
    state.lastSystemHead = String(options.system || '').slice(0, 60)
    state.lastProvider = String(options.provider || '')
    state.lastOptionsKeys = Object.keys(options).slice(0, 24).join(',')
    // 标记这次请求是客厅的子调用：宿主可能把 waterfall 分发推迟到 await 之后，
    // 光靠同步 depth 会漏；带一个不进 JSON 的 symbol 兜底。
    try {
      Object.defineProperty(options, ROOM_CALL, { value: true, enumerable: false })
    } catch { /* 冻结对象就只靠 depth */ }
    trace({ phase: state.phase, callIndex: state.callIndex })
    // 护栏包住「取流 + 迭代」整段：只包同步那一下，宿主异步分发时会重进 onStream
    // → handle → 新 generator，一秒几百次，最后整个宿主死掉（2026-11-14 roomCalls 8318）。
    roomCallDepth++
    try {
      let raw
      try {
        raw = client.stream(options)
      } catch (err) {
        state.lastCallError = errText(err)
        throw err
      }
      const pending = raw && typeof raw.then === 'function'
      const stream = pending ? await raw : raw
      const debug = {}
      try {
        const text = await collect(stream, debug)
        if (guard.timedOut()) throw new Error('子调用超时')
        return text
      } catch (err) {
        state.lastCallError = guard.timedOut() ? '子调用超时' : errText(err)
        throw guard.timedOut() ? new Error('子调用超时') : err
      } finally {
        state.lastStreamKind = pending ? `promise:${debug.kind || ''}` : (debug.kind || '')
        state.lastChunkTag = debug.firstTag || ''
        state.lastChunkKeys = debug.firstKeys || ''
        state.lastChunks = debug.chunks || 0
        state.lastFinishReason = debug.firstReason || ''
        state.lastFailureCode = debug.failureCode || ''
        state.lastFailureMessage = debug.failureMessage || ''
      }
    } finally {
      roomCallDepth = Math.max(0, roomCallDepth - 1)
      guard.done()
      state.phase = ''
      state.lastCallMs = Date.now() - startedAt
      trace({
        phase: '',
        kind: state.lastCallKind,
        ms: state.lastCallMs,
        streamKind: state.lastStreamKind,
        chunkTag: state.lastChunkTag,
        chunks: state.lastChunks,
        finish: state.lastFinishReason,
        failure: state.lastFailureCode,
        failureMsg: state.lastFailureMessage,
        provider: state.lastProvider,
        error: state.lastCallError,
      })
    }
  }

  /**
   * 返回 AsyncIterable 表示接管；null 表示交回宿主普通生成。
   * 异步工作包在生成器里，保证 attach 能同步拿到可迭代对象。
   */
  function handle(options = {}) {
    let setup = null
    try { setup = getSetup() } catch (err) {
      log(`客厅：读 setup 失败（${errText(err)}）`)
      return null
    }
    if (!setup || setup.room !== true) return null

    // 门票：贴了通行码就开门（消耗那张码）；没门票就回一句提示，不跑客厅。
    if (roomTicket && typeof roomTicket === 'object') {
      const said = lastUserText(options.messages || [])
      let opened = false
      try { opened = Boolean(roomTicket.consume && roomTicket.consume(said)) } catch { opened = false }
      if (opened) {
        try { if (typeof roomTicket.open === 'function') roomTicket.open() } catch { /* 门票写不进去就当没开 */ }
        return textStream('门开了。', { noRecord: true })
      }
      let active = false
      try { active = Boolean(roomTicket.active && roomTicket.active()) } catch { active = false }
      if (!active) return textStream(ROOM_LOCKED_LINE, { noRecord: true })
    }

    // 空消息（宿主心跳/注入块被清洗后什么都不剩）不接管：交回宿主普通生成。
    // 否则模型会顺着上一轮的口气自己续一句（2026-11-14 真机：空白消息后鲸歌用妹妹的口气发问）。
    if (!lastUserText(options.messages || [])) return null

    if (needsRoomWelcome(setup)) {
      const next = markRoomWelcomeSent(setup)
      saveNextSetup(next)
      state.welcomes++
      // 3 条相同提醒：宿主一次只能回一条消息，这里用空行隔成 3 段；
      // 不写 welcome 事件、不落库，noRecord 标记交给 attach。
      return textStream(roomReminderMessages().join('\n\n'), { noRecord: true })
    }

    const it = (async function* () {
      state.roomCalls++
      const turnStartedAt = Date.now()
      // 宿主真的开始迭代这个 generator 了，才会有这一行；没有就说明卡在更外层。
      trace({ phase: 'turn-start', roomCalls: state.roomCalls })
      let result
      try {
        result = await withTimeout(runRoom({
          messages: options.messages || [],
          call: (system, messages, kind) => callModel(system, messages, options, kind),
          piscesSystem: systemOf(piscesSystem),
          fishSystem: systemOf(fishSystem),
        }), turnTimeoutMs, '客厅一轮超时')
      } catch (err) {
        state.errors++
        state.lastError = errText(err)
        trace({ phase: 'turn-error', error: state.lastError })
        log(`客厅：一轮失败（${state.lastError}）`)
        return
      } finally {
        state.lastTurnMs = Date.now() - turnStartedAt
      }
      if (result.error) {
        state.errors++
        state.lastError = String(result.error)
        log(`客厅：一轮失败（${state.lastError}）`)
      }
      state.lastText = String(result.text || '')
      if (result.teaching) writeTeaching(result.teaching, result.text)
      if (typeof onTurn === 'function' && result.text) {
        try {
          await onTurn({
            user: lastUserText(options.messages || []),
            text: result.text,
            teaching: result.teaching,
          })
        } catch (err) {
          log(`客厅：onTurn 失败（${errText(err)}）`)
        }
      }
      if (result.text) yield { type: 'text-delta', index: 0, text: result.text }
      trace({
        phase: 'turn-end',
        errors: state.errors,
        textLen: state.lastText.length,
        calls: result.calls ?? 0,
      })
    })()
    // 客厅是独立工作区：这轮输出只进 room-log（onTurn），不再当鲸歌的 utterance 写进主库。
    it.__piscesNoRecord = true
    return it
  }

  return {
    handle,
    info: () => Object.freeze({
      ...state,
      lastText: undefined,
      lastTextLen: String(state.lastText || '').length,
      // 当前卡在这一步多少毫秒；空 phase 时是 0。卡住时先看这个数。
      phaseMs: state.phase ? Math.max(0, Date.now() - state.phaseAt) : 0,
      hasLlm: Boolean(resolveLlm()),
    }),
  }
}
