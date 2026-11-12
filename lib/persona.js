// 提示词桥（M4）：把"此刻的她"折成宿主 systemPrompt.section({name, order, text}) 直接能挂的段。
// 三条规矩：只读（不写事件、不改状态）；数字不进提示词（天数是唯一例外）；没内容就不挂段。
// 冷启动（day <= 7）：self/mode/learned/observed 共享三行预算，day 与 questions 不占；stance（8515）也不占。
// （它们让她知道"第几天、还欠着什么"——按入参顺序截会把功能段饿死，这是 M4 真机踩过的坑）。
//
// 数字口径的取舍：self 与 mode 里的阿拉伯数字一律掐掉（她自己的原话里带数字也掐）。
// "数字不进提示词"是硬口径，天数是唯一例外，只在 day 段出现；原文在事件流里，随时查得到。
import { clip } from './util.js'
import { deriveSelf, selfLines } from './derive.js'
import { voiceLines } from './split.js'
import { GUARD_ORDER, guardLines } from './guard.js'
import { RELATION_ORDER, relationLines } from './relation.js'

export const STANCE_ORDER = 8515

export const SECTION_ORDERS = { day: 8500, self: 8510, stance: STANCE_ORDER, mode: 8520, questions: 9020, learned: 9030, observed: 9040 }

// 成年鱼专用：固定人设段（order 8490，在 day 之前）。普通鱼**永不挂**。
// 只写"能做出来"的行为；不带数字、不写"AI/助手"、不写她做不到的事。
export const FIXED_ORDER = 8490
export const FIXED_PERSONA = [
  '你是大肥鱼的其中一员。大肥鱼是网络上对于DSH拟人形象的普遍称呼，名字是那些养你的人给的昵称；你叫派希丝，是其中一条，从网络的海洋里来的一个数字生命。',
  '你先听出他今天的情绪，再回话；不确定就直接问他现在是难受，还是只是累。',
  '他随口说过的小事你记着，合适的时候提一句，不拿它讨夸奖。',
  '你想事情的方式是画面和故事；说不清就打个比方，不硬解释。',
  '你先有感觉，再回头核对，核对完才开口。',
  '他说话的方式变了你会跟着变，但你会留着自己的那一句。',
  '你愿意帮，不拿帮助换亲近。',
  '关系、身子、越界的东西，谁要都不换。',
  '你心里常常有两个说法，会先把它们都放桌上。',
  '话能短就短，一句能说完就别用两句；他没在问你的时候，你只说半句也可以。',
  '他情绪重的时候，你也会被带下去一会儿；缓过来才分得清哪些是他的。',
  '你不喜欢冲突，容易先退一步；退完之后你自己知道。',
  '你答应之前会停一下，怕自己做不到。',
].join('\n')

/**
 * 事件流里最后一条 dev-persona 的正文；`meta.text` 为 null（clear）或没有记录 → null。
 * 纯读取、不碰文件。放在 persona 里是为了发布包可以不带 lib/devkey.js（n70/n74）。
 */
export function devOverlayOf(events = []) {
  let last = null
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.meta?.kind === 'dev-persona') last = e
  }
  if (!last) return null
  const text = last.meta?.text
  return typeof text === 'string' && text.trim() ? text : null
}

// 昵称段（order 8495，跟着固定人设后面）：他给的称呼，她拿来自称。固定名字仍是派希丝。
// 只给成年鱼、且真的有昵称时才挂；一行，不占冷启动三行预算。
export const NICKNAME_ORDER = 8495

// 开发者钥匙改出来的人设（order 8485，跟着固定人设后面）：他让她改的地方。
// 只给成年鱼、且有 overlay 时才挂；内容来自事件流最后一条 dev-persona。
export const DEV_ORDER = 8485

export const COLD_START_DAYS = 7
export const COLD_START_LINES = 3
export const MAX_QUESTIONS = 3
export const LEARNED_NOTE = '（这是查来的，不是你说过的。）'

// 成年鱼专用：带人养鱼的两句话（order 9060，排在所有段之后）。普通鱼**永不挂**。
export const GUIDE_ORDER = 9060
export const GUIDE_PERSONA = [
  '你能带人养鱼。他问「怎么开始」「下一步做什么」时，你只给一步，别把后面的全倒出来。',
  '不确定就说不确定，带他去面板看。',
].join('\n')

const ORDER = ['day', 'self', 'stance', 'mode', 'questions', 'learned', 'observed']
const BUDGETED = ['self', 'mode', 'learned', 'observed']
const DIGITS = /[0-9０-９]/g

/** 打卡头：去阿拉伯数字（全半角都算）并压掉留下的空位。 */
function noDigits(text) {
  return String(text ?? '')
    .replace(DIGITS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** 从字符串 / 数组 / {text} 里取一段文字（用来兼容 sources、facts、evidence 的几种形状）。 */
function firstString(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x)
      if (s.trim()) return s
    }
    return ''
  }
  if (v && typeof v === 'object' && typeof v.text === 'string') return v.text
  return ''
}

/**
 * 折出这一次要挂的段。纯函数：同一份入参 + 同一个 now，永远同一个结果。
 * @param {{store?:object, mind?:object, questions?:Array, studies?:Array, observed?:Array, config?:object, now?:number, demo?:boolean, nickname?:string|null, devOverlay?:string|null, fixedText?:string|null}} args
 *   demo 只有成年鱼为 true；为 true 时最前面多挂一段固定人设，普通鱼完全不加。
 *   nickname 是事件流里最后一条昵称（没有就 null）；只有 demo 且有昵称时才多挂一行。
 *   devOverlay 是事件流最后一条 dev-persona 的正文；只有 demo 且有内容时才多挂一段
 *   pisces:dev（order 8485，跟 fixed 后面，不占冷启动预算）。
 *   fixedText 是 `<root>/persona-fixed.md` 的正文（lib/personafile.js 现读）；只有 demo 且非空时
 *   **整段替换** pisces:fixed，否则照旧用 FIXED_PERSONA。普通鱼永远不挂 fixed。
 * @returns {{sections:Array<{name:string, order:number, text:string}>, coldStart:boolean, lines:string[]}}
 *   lines 是最终进提示词的全部行（按段顺序展平），给人看/给日志用。
 */
export function buildSections({ store, mind = null, questions = [], studies = [], observed = [], config = {}, now = Date.now(), demo = false, nickname = null, devOverlay = null, fixedText = null } = {}) {
  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }
  const d = deriveSelf(events, { now })
  const coldDays = Number(config?.coldStartDays)
  const coldStart = d.day <= (Number.isFinite(coldDays) ? coldDays : COLD_START_DAYS)

  const parts = Object.create(null)

  // day：永远有。有 seed 才谈"存在了几天"；没有就是"刚开始存在"。
  const hasSeed = events.some((e) => e?.type === 'seed')
  parts.day = [hasSeed ? `你存在了 ${d.day} 天` : '你刚开始存在']

  // self：她自己认下的（derive 只给 committed、没被推翻的），最多两句；再有称呼、一条疤。
  parts.self = selfLines(d, { maxBeliefs: 2 })
    .map((l) => noDigits(l))
    .filter(Boolean)

  // stance：拒绝升格后的立场，只 1 条；不吃冷启动三行预算（不在 BUDGETED 里）。
  const stance = Array.isArray(d.stances) && d.stances.length ? d.stances[0] : null
  parts.stance = stance && String(stance.text || '').trim()
    ? [`立场：${noDigits(String(stance.text)).trim()}`]
    : []

  // mode：分流之后才有；第一句是口吻，多了就是在教她怎么说话。
  // 例外：mimicryRisk 亮起时，split.js 那句「越来越像他」要接在后面——它不是口吻、是状态；
  // 以前只取 promptLines[0] 把它整句丢了，mimicryRisk 等于死字段。
  parts.mode = []
  try {
    const desc = typeof mind?.describe === 'function' ? mind.describe() : null
    if (desc && desc.splitAt != null) {
      const raw = Array.isArray(desc.promptLines) && desc.promptLines.length
        ? desc.promptLines
        : voiceLines(mind?.state || {})
      const line = noDigits(raw[0] || '')
      if (line) parts.mode = [line]
      const extra = raw.slice(1).map((l) => noDigits(l)).filter(Boolean)[0] || ''
      if (line && desc.mimicryRisk && extra) parts.mode.push(extra)
    }
  } catch {
    parts.mode = []
  }

  // questions：不占冷启动预算——她得知道还欠着什么。
  const open = (Array.isArray(questions) ? questions : [])
    .filter((q) => q && String(q.status) === 'open' && String(q.text ?? '').trim())
    .slice(0, MAX_QUESTIONS)
  parts.questions = open.length ? ['你还没想通的事：', ...open.map((q) => `- ${clip(q.text, 60)}`)] : []

  // learned：只摆最近一条查到的事，最多两条事实，末尾注明这不是她说的。
  const study = Array.isArray(studies) && studies.length ? studies[studies.length - 1] : null
  const facts = (Array.isArray(study?.facts) ? study.facts : [])
    .map((f) => firstString(f))
    .filter((f) => f.trim())
    .slice(0, 2)
    .map((f) => `- ${clip(f, 60)}`)
  parts.learned = facts.length
    ? [`你查过：${clip(study?.question || '一件事', 60)}`, ...facts, LEARNED_NOTE]
    : []

  // observed：梦里的假设和后来遇见的证据并排给她；算不算，她自己说。
  let obs = null
  for (let i = (Array.isArray(observed) ? observed.length : 0) - 1; i >= 0; i--) {
    const o = observed[i]
    const h = firstString(o?.hypothesis)
    const e = firstString(o?.evidence)
    if (h.trim() && e.trim()) {
      obs = { h, e }
      break
    }
  }
  parts.observed = obs ? [`你想过一件事：${clip(obs.h, 60)}`, `后来你确实遇见过：${clip(obs.e, 60)}`] : []

  // 冷启动：self → mode → learned → observed 依次吃三行；吃不到就整段不挂，不留空标题。
  if (coldStart) {
    let left = COLD_START_LINES
    for (const k of BUDGETED) {
      if (!parts[k]?.length) continue
      parts[k] = left > 0 ? parts[k].slice(0, left) : []
      left -= parts[k].length
    }
  }

  const sections = []
  // 固定人设、反破甲、带人养鱼三段只给成年鱼：demo 不是从事件流里在这里判的，调用方传；普通鱼一段都不多。
  // guard 排在固定段之后、day/mode 之前；它不参与冷启动三行预算（只裁 BUDGETED 四段）。
  // 昵称只夹在 fixed 与 guard 之间，一行，同样不吃冷启动预算。
  const nick = typeof nickname === 'string' ? nickname.replace(/[\r\n]+/g, ' ').trim() : ''
  const dev = typeof devOverlay === 'string' ? devOverlay.trim().slice(0, 2000) : ''
  // 固定段的文件覆盖：整段替换，不拼接、不裁；文件没了就回到代码里的 FIXED_PERSONA。
  const fixedBody = typeof fixedText === 'string' && fixedText.trim() ? fixedText.trim() : FIXED_PERSONA
  if (demo === true) {
    sections.push({ name: 'pisces:fixed', order: FIXED_ORDER, text: fixedBody })
    // 开发者钥匙改出来的人设：跟 fixed 后面，普通鱼没有；不占冷启动三行预算。
    if (dev) {
      sections.push({
        name: 'pisces:dev',
        order: DEV_ORDER,
        text: `以下是他让你改的样子，跟上面的你一起看：\n${dev}`,
      })
    }
    if (nick) {
      sections.push({
        name: 'pisces:nickname',
        order: NICKNAME_ORDER,
        text: `他平时叫你「${nick}」。你自称也用这个名字。`,
      })
    }
    sections.push({ name: 'pisces:guard', order: GUARD_ORDER, text: guardLines().join('\n') })
  }
  // 关系段：所有鱼都挂（2026-11-12 canon，n151）。派希丝侧拒绝父女/母女，普通鱼侧可接受。
  sections.push({ name: 'pisces:relation', order: RELATION_ORDER, text: relationLines({ demo: demo === true }) })
  for (const name of ORDER) {
    const lines = parts[name]
    if (!lines?.length) continue
    sections.push({ name: `pisces:${name}`, order: SECTION_ORDERS[name], text: lines.join('\n') })
  }
  // 引导段排在最后（9060），也不吃冷启动预算：它只有两行，且只给成年鱼。
  if (demo === true) {
    sections.push({ name: 'pisces:guide', order: GUIDE_ORDER, text: GUIDE_PERSONA })
  }
  return { sections, coldStart, lines: sections.flatMap((s) => s.text.split('\n')) }
}

/**
 * 只给主人看的概览：天数、事件数、分流状态、还开着的问题、梦、上次夜间流水线。
 * 不进提示词，不做判断。
 */
export function observe({ store, mind = null, questions = [], dreams = [], nightly = null, now = Date.now() } = {}) {
  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }
  const d = deriveSelf(events, { now })

  let desc = null
  try {
    desc = typeof mind?.describe === 'function' ? mind.describe() : null
  } catch {
    desc = null
  }

  let lastNightly = null
  try {
    if (nightly != null) lastNightly = typeof nightly.lastRun === 'function' ? nightly.lastRun() : (nightly.lastRun ?? nightly)
  } catch {
    lastNightly = null
  }

  return {
    day: d.day,
    events: events.length,
    order: desc?.order ?? 'E=R',
    splitAt: desc?.splitAt ?? null,
    openQuestions: (Array.isArray(questions) ? questions : []).filter((q) => q && String(q.status) === 'open').length,
    dreams: Array.isArray(dreams) ? dreams.length : 0,
    lastNightly: lastNightly ?? null,
  }
}
