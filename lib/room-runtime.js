// 客厅运行时：把 runRoom / welcome / teaching 接到宿主 llm 上。
//
// 只在 attach 判定「她屋里那条会话 + setup.room」时调用；不建 session。
// 普通客厅输出由 attach 包一层落一条 utterance；只有 welcome 3 连标 noRecord，
// 不写事件、不存正文。子调用带 __piscesRoom，attach 看到就原样 next()，防递归/防落库。
import { markRoomWelcomeSent, needsRoomWelcome } from './setup.js'
import { runRoom } from './room-run.js'
import { lessonText } from './room.js'
import { roomReminderMessages } from './welcome.js'

const errText = (err) => String(err?.message ?? err ?? '未知错误')

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

async function collect(stream) {
  if (!stream) return ''
  let text = ''
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) text += chunkText(chunk)
    return text
  }
  if (Array.isArray(stream)) return stream.map(chunkText).join('')
  return typeof stream === 'string' ? stream : ''
}

function textStream(text, { noRecord = false } = {}) {
  const it = (async function* () {
    if (text) yield { type: 'text-delta', text }
  })()
  if (noRecord) it.__piscesNoRecord = true
  return it
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue
    const c = list[i].content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('').trim()
    }
  }
  return ''
}

/**
 * @param {{
 *   llm: { stream: Function },
 *   getSetup: () => object | null,
 *   saveSetup?: (setup: object) => void,
 *   getStore?: () => object | null,
 *   fishSystem?: string | (() => string),
 *   piscesSystem?: string | (() => string),
 *   log?: (message: string) => void,
 * }} deps
 */
export function createRoomRuntime({
  llm,
  getSetup,
  saveSetup = null,
  getStore = null,
  fishSystem = '',
  piscesSystem = '',
  onTurn = null,
  log = () => {},
} = {}) {
  const state = {
    roomCalls: 0,
    welcomes: 0,
    teachings: 0,
    errors: 0,
  }

  const systemOf = (v) => {
    try {
      return typeof v === 'function' ? String(v() ?? '') : String(v ?? '')
    } catch {
      return ''
    }
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

  async function callModel(system, messages, baseOptions) {
    const options = {
      ...baseOptions,
      system,
      messages,
      tools: [],
      // attach 看到这个标记就原样 next()：不递归进客厅、不记 heard/utterance。
      __piscesRoom: true,
    }
    const stream = await llm.stream(options)
    return collect(stream)
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

    if (needsRoomWelcome(setup)) {
      const next = markRoomWelcomeSent(setup)
      saveNextSetup(next)
      state.welcomes++
      // 3 条相同提醒：宿主一次只能回一条消息，这里用空行隔成 3 段；
      // 不写 welcome 事件、不落库，noRecord 标记交给 attach。
      return textStream(roomReminderMessages().join('\n\n'), { noRecord: true })
    }

    return (async function* () {
      state.roomCalls++
      const result = await runRoom({
        messages: options.messages || [],
        call: (system, messages) => callModel(system, messages, options),
        piscesSystem: systemOf(piscesSystem),
        fishSystem: systemOf(fishSystem),
      })
      if (result.error) {
        state.errors++
        log(`客厅：一轮失败（${result.error}）`)
      }
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
      if (result.text) yield { type: 'text-delta', text: result.text }
    })()
  }

  return {
    handle,
    info: () => Object.freeze({ ...state }),
  }
}
