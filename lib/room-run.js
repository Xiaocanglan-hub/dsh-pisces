// 客厅跑一轮：虚拟调用普通鱼/派希丝，监测补句，点名妹妹，教学触发。
//
// 不建 session、不碰宿主、不写库：call(system, messages) 由调用方注入
// （生产里包 ctx.llm.stream），写不写 utterance / teaching 由 attach 决定。
import { composeRoom, detectTeaching, lessonText, monitorVerdict, oneSentence, parseMentions } from './room.js'

const errText = (err) => String(err?.message ?? err ?? '未知错误')

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
    .join('')
}

function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return contentText(list[i].content).trim()
  }
  return ''
}

function historyOf(messages, limit = 20) {
  const list = Array.isArray(messages) ? messages : []
  return list
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && contentText(m.content).trim())
    .slice(-limit)
    .map((m) => ({ role: m.role, content: contentText(m.content).trim() }))
}

function withSpeechLimit(system) {
  return `${system || ''}\n\n[客厅] 只回一句，不超过一个句号。不要解释，不要列点。`.trim()
}

function monitorSystem(system) {
  return `${system || ''}\n\n[客厅监测] 你是派希丝。看完这段，判断要不要补一句：不补只回 NO；要补就只回一句；要妹妹接话就在句首写 @普通鱼；要教她一条就只回 TEACH。`.trim()
}

/**
 * @param {{
 *   messages?: object[],
 *   call: (system: string, messages: object[]) => Promise<string>,
 *   piscesSystem?: string,
 *   fishSystem?: string,
 * }} input
 * @returns {Promise<{text:string, teaching:object|null, calls:number, error:string|null}>}
 */
export async function runRoom({ messages = [], call, piscesSystem = '', fishSystem = '' } = {}) {
  const userText = lastUserText(messages)
  const history = historyOf(messages)
  const mentions = parseMentions(userText)
  const lesson = detectTeaching(userText)
  let calls = 0
  const ask = async (system, msgs) => {
    calls++
    try {
      return String((await call(system, msgs)) ?? '')
    } catch (err) {
      return `__ERR__${errText(err)}`
    }
  }

  // 教学优先：命中教学库时派希丝直接教，不走普通补句。
  if (lesson) {
    return { text: lessonText(lesson), teaching: lesson, calls: 0, error: null }
  }

  // 被点名：只让被点的角色开口；派希丝被点时不自动补妹妹。
  if (mentions.pisces && !mentions.fish) {
    const raw = await ask(withSpeechLimit(piscesSystem), history)
    if (raw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: raw.slice(7) }
    return { text: composeRoom({ pisces: oneSentence(raw) }), teaching: null, calls, error: null }
  }
  if (mentions.fish && !mentions.pisces) {
    const raw = await ask(withSpeechLimit(fishSystem), history)
    if (raw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: raw.slice(7) }
    return { text: composeRoom({ fish: oneSentence(raw) }), teaching: null, calls, error: null }
  }

  // 普通一轮：妹妹先说，派希丝监测是否补一句 / 点名 / 不补。
  const fishRaw = await ask(withSpeechLimit(fishSystem), history)
  if (fishRaw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: fishRaw.slice(7) }
  const fish = oneSentence(fishRaw)
  const verdict = monitorVerdict(await ask(monitorSystem(piscesSystem), [
    ...history,
    { role: 'assistant', content: `【普通鱼】${fish}` },
  ]))
  if (!verdict.speak) return { text: composeRoom({ fish }), teaching: null, calls, error: null }
  if (verdict.callFish) {
    const again = await ask(withSpeechLimit(fishSystem), [
      ...history,
      { role: 'assistant', content: `【派希丝】${verdict.text || '你来说。'}` },
    ])
    if (again.startsWith('__ERR__')) return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: again.slice(7) }
    return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: null }
  }
  return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: null }
}
