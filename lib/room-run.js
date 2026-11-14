// 客厅跑一轮：虚拟调用普通鱼/派希丝，监测补句，点名妹妹，教学触发。
//
// 不建 session、不碰宿主、不写库：call(system, messages) 由调用方注入
// （生产里包 ctx.llm.stream），写不写 utterance / teaching 由 attach 决定。
import { composeRoom, detectTeaching, lessonText, monitorVerdict, oneSentence, parseMentions, stripSpeakPrefix } from './room.js'
import { getCast } from './cast.js'
import { stripHarnessNoise } from './noise.js'

const errText = (err) => String(err?.message ?? err ?? '未知错误')

/** 她常常会照着历史自己写一遍「【鲸歌】」开头，这里统一剥掉，再由 composeRoom 套一次。 */
const say = (raw) => oneSentence(stripSpeakPrefix(raw))

/**
 * 客厅里用户那条要过噪声清洗：宿主注入的 `<system-reminder>` 整块（知识库大纲、技能目录、
 * 交接摘要…）不是他说的，混进来会让两条鱼把系统提示当对话内容（2026-11-14 真机踩到：
 * 鲸歌看了半页系统提示，回「姐姐是鲸歌，我是鲸漪，这里没有我的妹妹」）。剥完再截断。
 */
const cleanUser = (t) => stripHarnessNoise(String(t ?? '')).trim().slice(0, 800)

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
    if (list[i]?.role === 'user') return cleanUser(contentText(list[i].content))
  }
  return ''
}

/** 宿主 Message.content 永远是 ContentBlock[]，不是字符串；拼消息一律用这个。 */
function textBlocks(text) {
  return [{ type: 'text', text }]
}

function historyOf(messages, limit = 20) {
  const list = Array.isArray(messages) ? messages : []
  const rows = []
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const raw = contentText(m.content)
    const text = m.role === 'user' ? cleanUser(raw) : raw.trim()
    if (!text) continue
    // 整条消息留着（id / source 都在）：宿主 dsh-llm 的 forAdapter() 会读
    // assistant 消息的 source.replayState。
    // content 折成「只有文本 block」的数组：宿主 serialize() 直接对 content 调 flatMap，
    // 给字符串会 TypeError，最后被兜成 TRANSPORT（n194 真机实测）；顺手丢掉工具块，
    // 免得历史里留着 tool_use 却缺 tool_result，serialize 会判 INVALID_REQUEST。
    rows.push({ ...m, content: textBlocks(text) })
  }
  return rows.slice(-limit)
}

function withSpeechLimit(system) {
  return `${system || ''}\n\n[客厅] 只回一句，不超过一个句号。不要解释，不要列点。`.trim()
}

function monitorSystem(system) {
  const { adult, ordinary } = getCast()
  return `${system || ''}\n\n[客厅监测] 你是${adult.name}。看完这段，判断要不要补一句：不补只回 NO；要补就只回一句；要${ordinary.name}接话就在句首写 @${ordinary.name}；要教她一条就只回 TEACH。`.trim()
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
  const { adult, ordinary } = getCast()
  // 每次开口都先把「你现在是谁、对面是谁」钉在 system 末尾：
  // 不然多轮之后她会顺着历史里上一位的口吻说（2026-11-14 真机：鲸歌用妹妹的口气发问）。
  const anchor = (self, other) =>
    `\n\n[客厅] 你现在的身份是${self.name}（${self.label}），对面是${other.name}（${other.label}）。只说你自己那句，不替对方说。`
  const fishSys = () => withSpeechLimit(`${fishSystem}${anchor(ordinary, adult)}`)
  const piscesSys = () => withSpeechLimit(`${piscesSystem}${anchor(adult, ordinary)}`)
  const mentions = parseMentions(userText)
  const lesson = detectTeaching(userText)
  let calls = 0
  const ask = async (kind, system, msgs) => {
    calls++
    try {
      // kind 只是给调用方看的"卡在哪一步"，不影响调用本身。
      return String((await call(system, msgs, kind)) ?? '')
    } catch (err) {
      return `__ERR__${errText(err)}`
    }
  }

  // 教学优先：妹妹先答一句，派希丝接着教（她会主动发话）。
  if (lesson) {
    const raw = await ask('fish', fishSys(), history)
    if (raw.startsWith('__ERR__')) {
      return { text: composeRoom({ pisces: lessonText(lesson) }), teaching: lesson, calls, error: raw.slice(7) }
    }
    return {
      text: composeRoom({ fish: say(raw), pisces: lessonText(lesson) }),
      teaching: lesson,
      calls,
      error: null,
    }
  }

  // 两个都点了名：各回一句（分开两段）。**谁先被提到谁先说**——
  // 用户会说「鲸漪先问，鲸歌回答」，固定让鲸歌先就会把名字顶反（2026-11-14 真机）。
  if (mentions.fish && mentions.pisces) {
    const adultAt = userText.indexOf(adult.name)
    const fishAt = userText.indexOf(ordinary.name)
    const piscesFirst = adultAt >= 0 && (fishAt < 0 || adultAt < fishAt)

    if (piscesFirst) {
      const piscesRaw = await ask('pisces', piscesSys(), history)
      if (piscesRaw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: piscesRaw.slice(7) }
      const piscesText = say(piscesRaw)
      const fishRaw = await ask('fish', fishSys(), [
        ...history,
        { role: 'assistant', content: textBlocks(`【${adult.name}】${piscesText}`) },
        { role: 'user', content: textBlocks(`请以${ordinary.name}（${ordinary.label}）的身份接一句。`) },
      ])
      if (fishRaw.startsWith('__ERR__')) {
        return { text: composeRoom({ pisces: piscesText }), teaching: null, calls, error: fishRaw.slice(7) }
      }
      return {
        text: composeRoom({ fish: say(fishRaw), pisces: piscesText, first: 'pisces' }),
        teaching: null,
        calls,
        error: null,
      }
    }

    const fishRaw = await ask('fish', fishSys(), history)
    if (fishRaw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: fishRaw.slice(7) }
    const fish = say(fishRaw)
    const piscesRaw = await ask('pisces', piscesSys(), [
      ...history,
      { role: 'assistant', content: textBlocks(`【${ordinary.name}】${fish}`) },
      { role: 'user', content: textBlocks(`请以${adult.name}（${adult.label}）的身份回一句。`) },
    ])
    if (piscesRaw.startsWith('__ERR__')) {
      return { text: composeRoom({ fish }), teaching: null, calls, error: piscesRaw.slice(7) }
    }
    return { text: composeRoom({ fish, pisces: say(piscesRaw) }), teaching: null, calls, error: null }
  }

  // 被点名：只让被点的角色开口；派希丝被点时不自动补妹妹。
  if (mentions.pisces && !mentions.fish) {
    const raw = await ask('pisces', piscesSys(), history)
    if (raw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: raw.slice(7) }
    return { text: composeRoom({ pisces: say(raw) }), teaching: null, calls, error: null }
  }
  if (mentions.fish && !mentions.pisces) {
    const raw = await ask('fish', fishSys(), history)
    if (raw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: raw.slice(7) }
    return { text: composeRoom({ fish: say(raw) }), teaching: null, calls, error: null }
  }

  // 普通一轮：妹妹先说，派希丝监测是否补一句 / 点名 / 不补。
  const fishRaw = await ask('fish', fishSys(), history)
  if (fishRaw.startsWith('__ERR__')) return { text: '', teaching: null, calls, error: fishRaw.slice(7) }
  const fish = say(fishRaw)
  const verdict = monitorVerdict(await ask('monitor', monitorSystem(piscesSystem), [
    ...history,
    { role: 'assistant', content: textBlocks(`【${ordinary.name}】${fish}`) },
    // 不能以 assistant 结尾：模型会被叫去“继续写”，宿主侧直接 finish:error。
    { role: 'user', content: textBlocks('现在轮到你判断：她这句要不要补、要不要点名，还是只回 NO。') },
  ]))
  if (!verdict.speak) return { text: composeRoom({ fish }), teaching: null, calls, error: null }
  if (verdict.callFish) {
    const again = await ask('again', fishSys(), [
      ...history,
      { role: 'assistant', content: textBlocks(`【${adult.name}】${verdict.text || '你来说。'}`) },
      { role: 'user', content: textBlocks(`${adult.name}叫你了，接一句。`) },
    ])
    if (again.startsWith('__ERR__')) return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: again.slice(7) }
    return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: null }
  }
  return { text: composeRoom({ fish, pisces: verdict.text }), teaching: null, calls, error: null }
}
