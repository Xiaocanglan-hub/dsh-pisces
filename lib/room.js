// 客厅的纯逻辑：点名、一句上限、监测判定、拼接、教学触发。
// 不碰宿主、不建 session、不落库；调用方负责虚拟调用与落库策略。
// 2026-11-13：称呼从 cast 取（n192）。本机 fish=鲸歌、pisces=派希丝；
// 顺序不变——普通鱼状态先说、成年鱼（派希丝）监测。
import { matchLesson } from './lessons.js'
import { getCast } from './cast.js'

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 支持 @名字 / 名字 / 称呼（姐姐/妹妹）；称呼按 cast 走。
 *  名字随便出现都算点名；**称呼只认句首或 @ 后面的**——不然「你有什么要问姐姐吗」
 *  这种第三人称叙事也会被当成“点了姐姐”（2026-11-14 真机踩到，导致两人都开口、顺序错）。 */
export function parseMentions(text) {
  const s = String(text ?? '')
  const { adult, ordinary } = getCast()
  const namePart = (n) => `@?${esc(n)}`
  const labelPart = (l) => `(?:^|@)${esc(l)}`
  const adultRe = new RegExp(`${namePart(adult.name)}|${labelPart(adult.label)}`)
  const ordinaryRe = new RegExp(`${namePart(ordinary.name)}|${labelPart(ordinary.label)}`)
  const pisces = adultRe.test(s)
  const fish = ordinaryRe.test(s)
  if (pisces || fish) return { pisces, fish }
  // 不认识的名字（2026-11-14 真机踩到）：用户在客厅里叫她「鲸漪」，但 cast 里只有
  // 「派希丝/妹妹」，点名永远匹配不上，于是 @鲸漪 被当成普通一句、只有鲸歌回。
  // 客厅只有两个人：只要 @ 的不是姐姐的名字，就当是在叫妹妹。
  const at = s.match(/@([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/)
  if (at && !ordinaryRe.test(at[1]) && !adultRe.test(at[1])) return { pisces: true, fish: false }
  return { pisces, fish }
}

/** 只留第一句；没有句号就整句返回。用于“只回复一句”。 */
export function oneSentence(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const m = s.match(/^[\s\S]*?[。！？!?]/)
  return (m ? m[0] : s).trim()
}

/**
 * 去掉她自己加的开头名字：历史里 assistant 是「【鲸歌】…」，模型会照着写，
 * 我们再套一层前缀就成了「【鲸歌】【鲸歌】…」。两种形态都剥：
 * `【任意名字】` 和 `鲸歌：` / `鲸漪：` / `派希丝：`。
 * 只剥开头、反复剥（可能两层），正文里的不动。
 */
export function stripSpeakPrefix(text) {
  const { adult, ordinary } = getCast()
  const names = [adult.name, adult.label, ordinary.name, ordinary.label, '派希丝'].filter(Boolean)
  let s = String(text ?? '').trim()
  let prev = ''
  let guard = 0
  while (s !== prev && guard++ < 5) {
    prev = s
    s = s.replace(/^【[^】]{1,16}】\s*/, '')
    for (const n of names) {
      s = s.replace(new RegExp(`^${esc(n)}\\s*[：:]\\s*`), '')
    }
    // 名字前缀的兜底：`某某：` 这种两到八个字的开头也剥（代词不算）。
    s = s.replace(/^([\u4e00-\u9fa5A-Za-z0-9_]{1,8})[：:]\s*/, (m, name) =>
      /^(我|你|他|她|它|我们|你们|他们|咱们)$/.test(name) ? m : '',
    )
  }
  return s.trim()
}

/** 拼接客厅一条消息；只放说了的角色；名字按 cast 走。两个人说就分成两段。
 *  first 决定谁在前：默认妹妹（ordinary）先；用户点的是「鲸漪先问鲸歌答」时传 'pisces'，
 *  不能永远把鲸歌排在前头（2026-11-14 真机：名字顶反）。 */
export function composeRoom({ fish = '', pisces = '', first = 'fish' } = {}) {
  const { adult, ordinary } = getCast()
  const fishPart = fish ? `【${ordinary.name}】${String(fish).trim()}` : ''
  const piscesPart = pisces ? `【${adult.name}】${String(pisces).trim()}` : ''
  const parts = first === 'pisces' ? [piscesPart, fishPart] : [fishPart, piscesPart]
  return parts.filter(Boolean).join('\n\n')
}

/** 把一条客厅消息拆回两条鱼各自的话；给 room-log 用。 */
export function splitRoom(text) {
  const { adult, ordinary } = getCast()
  const out = { fish: '', pisces: '' }
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim()
    if (s.startsWith(`【${ordinary.name}】`)) out.fish = s.slice(ordinary.name.length + 2).trim()
    else if (s.startsWith(`【${adult.name}】`)) out.pisces = s.slice(adult.name.length + 2).trim()
  }
  return out
}

/**
 * 派希丝监测的返回：NO/空 = 不补；TEACH = 教学；@ordinary = 点名 ordinary。
 * 其余当作要补的一句。
 */
export function monitorVerdict(text) {
  const raw = String(text ?? '').trim()
  if (!raw || /^NO$/i.test(raw) || /^不(说|补|用)?$/.test(raw)) return { speak: false }
  const teach = /^TEACH\b/i.test(raw)
  const body = teach ? raw.replace(/^TEACH\s*/i, '').trim() : raw
  const { adult, ordinary } = getCast()
  const callRe = new RegExp(
    `@${esc(ordinary.name)}|${esc(ordinary.name)}[，,：:\\s]*你|${esc(ordinary.label)}[，,：:\\s]*你`,
  )
  const callFish = callRe.test(body)
  const cleaned = stripSpeakPrefix(body)
  return { speak: true, teach, callFish, text: oneSentence(cleaned) }
}

/** 教学触发：按用户这句找一条课；没命中回 null。 */
export function detectTeaching(text) {
  return matchLesson(text)
}

/** 教学正文：成年鱼说 + 普通鱼练。 */
export function lessonText(lesson) {
  if (!lesson) return ''
  return `${lesson.teacher}\n${lesson.practice}`
}
