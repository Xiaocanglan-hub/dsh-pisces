// 宿主夹带在 user 消息里的系统噪声：计时行、时区行、运行时上下文行，以及一整块注入
// （知识库大纲、技能清单、<system-reminder>、会话标题生成请求）。它们不是他说的。
//
// 写入时：attach.js 记 heard 之前过一遍，剥完为空就不落库。
// 读取时：归因（reflect.js）和检索（search.js）也过同一份规则，这样早先已经落库的
// 脏 heard 不会被判成她的话、也不会被 recall 翻出来（历史数据不改不删）。
//
// 口径：噪声整行删；尾部附加块从标记行起删到结尾；有闭合标签的块删到闭合行；
// 一行全是 ─（U+2500，≥8）也是块头。剥完 trim，可能返回空串。
const NOISE_LINE = /^(?:Time sampled while preparing turn\b|Browser time zone\b|Elapsed since the preceding model-visible message:|Elapsed since the preceding step context:|Current runtime context\.|Current working directory:|Current DSH file policy:|Current DeepSeek Harness implementation checkout:|Current DeepSeek Harness Web GUI URL:|Approval prompts are disabled in this session:|关于这个工作区的知识库|<available_skills|<\/available_skills>)/i
const NOISE_BLOCK_MARKERS = [
  '这个文件属于',
  '关于这个工作的知识库',
  '关于这个工作区的知识库',
  '知识库（指令见前文',
]
const RULE_LINE = /^─{8,}$/

// 会话标题生成：宿主让模型给会话起名的请求，真机形状是整条 user 消息
// 「Generate the session title from this JSON array of human messages:」+ 一段 JSON。
// 只认英文祈使句 + title，宁可漏洗；JSON 是尾随块，所以从这行删到结尾。
const TITLE_PROMPT = /^\s*Generate (?:a |the )?(?:session|conversation|chat) title\b/i

// <system-reminder> / <系统提醒> 整块注入（技能目录等）。有闭合标签就只删这一块，
// 没有闭合就当尾部块删到结尾——不把块后面的他自己的话带走。
const REMINDER_OPEN = /<system-reminder>|<系统提醒>/i
const REMINDER_CLOSE = /<\/system-reminder>|<\/系统提醒>/i

/**
 * 剥掉宿主夹带在用户消息里的系统噪声；只用于"他说的话"，utterance 不清洗。
 * 剥完 trim；可能返回空串（整条都是注入块），调用方据此不落库/跳过。
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
    // 会话标题生成请求是尾部整块：正文是 human messages 的 JSON，一起删。
    if (TITLE_PROMPT.test(line)) break
    if (line.includes('<available_skills')) {
      // 技能清单有闭合标签：整块（含闭合行）删掉；没有闭合就当尾部块删到结尾。
      let j = i
      while (j < lines.length && !lines[j].includes('</available_skills>')) j++
      i = j
      continue
    }
    if (line.includes('</available_skills>')) continue
    if (REMINDER_OPEN.test(line)) {
      // 同一行就闭合的块只删这一行；否则删到闭合行；没有闭合就删到结尾。
      if (REMINDER_CLOSE.test(line)) continue
      let j = i + 1
      while (j < lines.length && !REMINDER_CLOSE.test(lines[j])) j++
      i = j
      continue
    }
    if (REMINDER_CLOSE.test(line)) continue
    if (NOISE_LINE.test(trimmed)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}
