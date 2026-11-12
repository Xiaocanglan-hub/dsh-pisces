// 客厅的纯逻辑：点名、一句上限、监测判定、拼接、教学触发。
// 不碰宿主、不建 session、不落库；调用方负责虚拟调用与落库策略。
import { matchLesson } from './lessons.js'

/** 支持 @派希丝 / 派希丝 / 姐姐，@普通鱼 / 普通鱼 / 妹妹；两种都支持。 */
export function parseMentions(text) {
  const s = String(text ?? '')
  return {
    pisces: /@?派希丝|@?姐姐/.test(s),
    fish: /@?普通鱼|@?妹妹/.test(s),
  }
}

/** 只留第一句；没有句号就整句返回。用于“只回复一句”。 */
export function oneSentence(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const m = s.match(/^[\s\S]*?[。！？!?]/)
  return (m ? m[0] : s).trim()
}

/** 拼接客厅一条消息；只放说了的角色。 */
export function composeRoom({ fish = '', pisces = '' } = {}) {
  const parts = []
  if (fish) parts.push(`【普通鱼】${String(fish).trim()}`)
  if (pisces) parts.push(`【派希丝】${String(pisces).trim()}`)
  return parts.join('\n')
}

/**
 * 派希丝监测的返回：NO/空 = 不补；TEACH = 教学；@普通鱼 = 点名妹妹。
 * 其余当作要补的一句。
 */
export function monitorVerdict(text) {
  const raw = String(text ?? '').trim()
  if (!raw || /^NO$/i.test(raw) || /^不(说|补|用)?$/.test(raw)) return { speak: false }
  const teach = /^TEACH\b/i.test(raw)
  const body = teach ? raw.replace(/^TEACH\s*/i, '').trim() : raw
  const callFish = /@普通鱼|普通鱼[，,：:\s]*你|妹妹[，,：:\s]*你/.test(body)
  const cleaned = body.replace(/^【派希丝】\s*/, '')
  return { speak: true, teach, callFish, text: oneSentence(cleaned) }
}

/** 教学触发：按用户这句找一条课；没命中回 null。 */
export function detectTeaching(text) {
  return matchLesson(text)
}

/** 教学正文：派希丝说 + 妹妹练。 */
export function lessonText(lesson) {
  if (!lesson) return ''
  return `${lesson.teacher}\n${lesson.practice}`
}
