// 梦（M3 下半）：把一条没想通的问题，做成一次有场景、反事实、模拟、假设和观察的梦。
//
// 口径（按"最差也能接受"写，不按"模型大概会好好写"写）：
// - 只挑最旧的一条 open 问题；同一 threadKey 只做一次，上一个梦不到 3 天不做（force 可跳）。
// - 模型只回一个 JSON；解析失败只落 meta 事件 dream:failed:*，不落 dream_sim。
// - 八道闸全过才落 dream_sim，并把那条问题标成 observed（不是 answered）。
// - 过不了闸也落一条"（这次没做成梦：…）"的 dream_sim 留痕（meta.rejected），但它不算一次梦，
//   不参与"3 天节奏"，也不占用 threadKey——下次还可以重做。
import { clip } from './util.js'
import { questionKey, normalizeQuestion, dice, listQuestions, setQuestionStatus } from './questions.js'

export const DREAM_MIN_SENTENCES = 5
export const DREAM_MAX_SENTENCES = 8

export const DREAM_GATES = [
  'scene-not-question',
  'counterfactual-if',
  'sentences',
  'hypothesis-testable',
  'test-actionable',
  'no-numbered-list',
  'not-empty',
  'thread-key',
]

const DAY = 86_400_000
const MIN_SCENE_CHARS = 10

// "下次/之后/再…时"这一小类可观察的词。只认这些，不放"会/应该"这类没法观察的词。
const ACTIONABLE = /(下次|之后|以后|后来|再[^，。；！？\n]{0,12}时|[一二三四五六七八九十几两0-9]{1,3}(?:天|周|个月|月)(?:后|之后|以后)|过[一二三四五六七八九十几两0-9]{1,3}(?:天|周|个月|月)|第二天|明天|观察|留意|看看|问一问|问一下|数一数|记下)/

// 模型爱写"1. 她……"这种步骤。行首、换行后、句号/逗号/冒号后都算编号；
// 结尾再排除小数点（3.5 不是编号）。
const NUMBERED = /(^|[\s\n。；;，,：:（(])\s*\d{1,2}\s*[.．、)）](?!\d)/

function asText(v) {
  return v == null ? '' : String(v)
}

function refsOf(v) {
  if (Array.isArray(v)) return v.map(String)
  try {
    const j = JSON.parse(String(v ?? '[]'))
    return Array.isArray(j) ? j.map(String) : []
  } catch {
    return []
  }
}

function questionTextOf(question, thread = '') {
  if (question && typeof question === 'object') {
    for (const k of ['text', 'question', 'thread']) {
      const t = question[k]
      if (t != null && String(t).trim()) return String(t)
    }
  } else if (typeof question === 'string' && question.trim()) {
    return question
  }
  return asText(thread)
}

function isRejected(ev) {
  return ev?.meta?.rejected != null || String(ev?.meta?.status ?? '') === 'rejected'
}

function lastRealDream(events) {
  let last = null
  for (const e of events) {
    if (e?.type !== 'dream_sim' || isRejected(e)) continue
    last = e
  }
  return last
}

function dreamedKeys(events) {
  const out = new Set()
  for (const e of events) {
    if (e?.type !== 'dream_sim' || isRejected(e)) continue
    const k = String(e?.meta?.threadKey ?? '')
    if (k) out.add(k)
  }
  return out
}

/** 从模型回复里抠 JSON：容忍 ```json 围栏和前后废话；抠不出/不是对象就抛。 */
function parseDreamJson(reply) {
  let s = asText(reply).trim()
  if (!s) throw new Error('模型只回了空')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  if (!s.startsWith('{')) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) throw new Error('没有 JSON 对象')
    s = s.slice(a, b + 1)
  }
  let obj
  try {
    obj = JSON.parse(s)
  } catch {
    throw new Error('JSON 解析失败')
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('JSON 不是对象')
  return obj
}

// 只留梦的五个字段，顺便把字符串首尾空白去掉；simulation 里非字符串的项留空，交给闸 3 拒。
function cleanDream(obj = {}) {
  return {
    scene: asText(obj.scene).trim(),
    counterfactual: asText(obj.counterfactual).trim(),
    simulation: Array.isArray(obj.simulation)
      ? obj.simulation.map((x) => (typeof x === 'string' ? x.trim() : ''))
      : obj.simulation,
    hypothesis: asText(obj.hypothesis).trim(),
    test: asText(obj.test).trim(),
  }
}

function dreamText(d) {
  const sim = (Array.isArray(d.simulation) ? d.simulation : [])
    .map((x) => {
      const t = asText(x).trim()
      return /[。！？!?…]$/.test(t) ? t : `${t}。`
    })
    .join('')
  return `${d.scene}\n${sim}`
}

export function dreamPrompt(thread, { question = '' } = {}) {
  const q = asText(thread || question).trim()
  return `你在做梦。这个梦围绕一件你还没想通的事：
${q}

只输出一个 JSON 对象，不要解释，不要代码围栏，字段如下：
{"scene":"...","counterfactual":"如果...","simulation":["...","..."],"hypothesis":"...","test":"..."}

要求：
- scene：一个具体的场景（人物、地点、动作），至少 ${MIN_SCENE_CHARS} 个字，不要复述上面的问题。
- counterfactual：必须以"如果"开头，写一个和现实不同的可能。
- simulation：${DREAM_MIN_SENTENCES} 到 ${DREAM_MAX_SENTENCES} 句，字符串数组，一句一个元素；不要用 1. 2. 这种编号。
- hypothesis：一个还能验的假设，用问句结尾或含"会不会/能否/是否/多少/几天"。
- test：一个下次能做的具体观察，含"下次/之后/再……时"这类词；不要写"会好的"这种没法观察的话。
`
}

/**
 * 八道闸。problems 是给人看的短句，每条以闸名开头。
 * @param {object} dream 模型给的梦（scene/counterfactual/simulation/hypothesis/test）
 * @param {{thread?:string, question?:string|object}} ctx 问题原句；question 可以是问题对象
 * @returns {{ok:boolean, problems:string[]}}
 */
export function checkDream(dream = {}, { thread = '', question = '' } = {}) {
  const d = dream && typeof dream === 'object' ? dream : {}
  const qtext = questionTextOf(question, thread)
  const scene = asText(d.scene).trim()
  const counterfactual = asText(d.counterfactual).trim()
  const simulation = d.simulation
  const hypothesis = asText(d.hypothesis).trim()
  const test = asText(d.test).trim()
  const problems = []

  // 1. scene-not-question：场景不能只是把问题抄一遍。Dice 用 questions.js 的中文 n-gram 口径。
  const refs = [qtext, asText(thread).trim()].filter((t, i, a) => t && a.indexOf(t) === i)
  if (scene && refs.some((t) => dice(scene, t) >= 0.8)) {
    problems.push('scene-not-question：场景只是把问题复述了一遍')
  }

  // 2. counterfactual-if：必须真的从"如果"开头。
  if (!counterfactual.startsWith('如果')) {
    problems.push('counterfactual-if：反事实必须以"如果"开头')
  }

  // 3. sentences：数组且 5–8 句；空句不算句子。
  if (!Array.isArray(simulation)) {
    problems.push('sentences：simulation 必须是数组')
  } else if (simulation.length < DREAM_MIN_SENTENCES || simulation.length > DREAM_MAX_SENTENCES) {
    problems.push(`sentences：模拟要 ${DREAM_MIN_SENTENCES}–${DREAM_MAX_SENTENCES} 句，现在是 ${simulation.length} 句`)
  } else if (simulation.some((s) => !asText(s).trim())) {
    problems.push('sentences：模拟里有空句')
  }

  // 4. hypothesis-testable：问句结尾，或含"会不会/能否/是否/多少/几天"。
  if (!/[？?]\s*$/.test(hypothesis) && !/(会不会|能否|是否|多少|几天)/.test(hypothesis)) {
    problems.push('hypothesis-testable：假设要能验（问句结尾，或含"会不会/能否/是否"）')
  }

  // 5. test-actionable：必须落到下次能做的观察上。
  if (!ACTIONABLE.test(test)) {
    problems.push('test-actionable：观察要具体（要含"下次/之后/再……时"这类词）')
  }

  // 6. no-numbered-list：scene / simulation 里不许出现 1. 2. 这种编号。
  const maybeNumbered = [scene, ...(Array.isArray(simulation) ? simulation : [])].map(asText)
  if (maybeNumbered.some((s) => NUMBERED.test(s))) {
    problems.push('no-numbered-list：不要写成 1. 2. 这样的步骤')
  }

  // 7. not-empty：场景至少 10 字；假设和观察都不能空。
  if (!scene || scene.length < MIN_SCENE_CHARS) {
    problems.push(`not-empty：场景至少 ${MIN_SCENE_CHARS} 个字`)
  }
  if (!hypothesis) problems.push('not-empty：假设不能为空')
  if (!test) problems.push('not-empty：观察不能为空')

  // 8. thread-key：问题原句要能算出 key（questions.questionKey）。
  if (!normalizeQuestion(qtext)) {
    problems.push('thread-key：算不出 threadKey（没有问题原句）')
  } else if (!/^[0-9a-f]{16}$/.test(questionKey(qtext))) {
    problems.push('thread-key：threadKey 形状不对')
  }

  return { ok: problems.length === 0, problems }
}

function failureEvent(store, { question, threadKey, why, now }) {
  const reason = clip(why || '模型没答上来', 120)
  return store.append({
    type: 'meta',
    text: `dream:failed:${reason}`,
    refs: question ? refsOf(question.refs).slice(0, 3) : [],
    meta: { kind: 'dream_failed', reason, threadKey },
    source: 'system',
    ts: now,
  })
}

/**
 * 做一次梦。
 *
 * 返回：
 * - 做成：{ ok:true, event, dream }
 * - 没做成：{ ok:false, reason, skipped? }；skipped 只在"还没到做梦的日子"出现。
 *
 * @param {object} opts
 * @param {object} opts.store 事件库（append/readAll/questionAll）
 * @param {{ask:Function}|null} opts.model 本地模型；没有就留一条 dream:failed
 * @param {Array|null} opts.questions 可选：调用方已经取好的 open 问题列表
 * @param {number} opts.now 当前时间（测试可注入）
 * @param {boolean} opts.force 跳过 3 天节奏
 * @param {number} opts.minIntervalDays 两次梦之间至少隔几天
 */
export async function dream({
  store,
  model = null,
  questions = null,
  now = Date.now(),
  force = false,
  minIntervalDays = 3,
  log = () => {},
} = {}) {
  if (!store || typeof store.append !== 'function' || typeof store.readAll !== 'function') {
    return { ok: false, reason: '没有库' }
  }

  const at = Number(now) || Date.now()
  const events = store.readAll() || []

  let pool
  if (Array.isArray(questions)) {
    pool = questions
  } else if (questions && typeof questions.listQuestions === 'function') {
    pool = questions.listQuestions(store, { status: 'open' })
  } else {
    pool = listQuestions(store, { status: 'open', limit: 500 })
  }

  const open = (Array.isArray(pool) ? pool : [])
    .filter((q) => q && String(q.status ?? 'open') === 'open')
    .map((q) => ({ ...q, refs: refsOf(q.refs) }))
    .sort((a, b) => (Number(a.since) || 0) - (Number(b.since) || 0) || String(a.key ?? '').localeCompare(String(b.key ?? '')))

  // 没有问题可做：不落任何事件。
  if (!open.length) return { ok: false, reason: '没有问题可做' }

  // 节奏：上一次"真的做成的梦"不到 minIntervalDays 天，就不做（force 可以跳）。
  const days = Number.isFinite(Number(minIntervalDays)) ? Math.max(0, Number(minIntervalDays)) : 3
  const last = lastRealDream(events)
  if (force !== true && last && at - Number(last.ts) < days * DAY) {
    return { ok: false, reason: '还没到做梦的日子', skipped: true }
  }

  // 同一个 threadKey 只做一次：已经做过的换下一条；全做过就没有可做的梦了。
  const done = dreamedKeys(events)
  const target = open.find((q) => {
    const tk = questionKey(q.text)
    return !done.has(tk) && !(q.key && done.has(String(q.key)))
  })
  if (!target) return { ok: false, reason: '没有没做过的梦' }

  const thread = asText(target.text).trim()
  const tk = questionKey(thread)
  const statusKey = target.key != null ? String(target.key) : tk
  const refs = refsOf(target.refs).slice(0, 3)

  // 没有模型：留一条 meta，不落 dream_sim。
  if (!model || typeof model.ask !== 'function') {
    await failureEvent(store, { question: target, threadKey: tk, why: '没有模型', now: at })
    return { ok: false, reason: '没有模型' }
  }

  let raw
  try {
    raw = await model.ask(dreamPrompt(thread))
  } catch (e) {
    const why = e?.message || String(e) || '模型没答上来'
    await failureEvent(store, { question: target, threadKey: tk, why, now: at })
    log?.(`做梦失败（模型）：${why}`)
    return { ok: false, reason: '模型没给成形的梦' }
  }

  let parsed
  try {
    parsed = cleanDream(parseDreamJson(raw))
  } catch (e) {
    const why = e?.message || String(e) || '不是成形的 JSON'
    await failureEvent(store, { question: target, threadKey: tk, why, now: at })
    log?.(`做梦失败（解析）：${why}`)
    return { ok: false, reason: '模型没给成形的梦' }
  }

  const check = checkDream(parsed, { thread, question: target })
  if (!check.ok) {
    // 留痕，但不假装这是一次梦：meta.rejected 让它不占 threadKey、也不算进 3 天节奏。
    const meta = {
      thread,
      threadKey: tk,
      ...parsed,
      status: 'rejected',
      rejected: check.problems,
    }
    const event = await store.append({
      type: 'dream_sim',
      text: `（这次没做成梦：${check.problems.join('；')}）`,
      refs,
      meta,
      source: 'system',
      ts: at,
    })
    log?.(`做梦没过闸：${check.problems.join('；')}`)
    return { ok: false, reason: check.problems.join('；') }
  }

  const meta = {
    thread,
    threadKey: tk,
    ...parsed,
    status: 'untested',
  }
  const event = await store.append({
    type: 'dream_sim',
    text: dreamText(parsed),
    refs,
    meta,
    source: 'system',
    ts: at,
  })

  // 问题只标 observed：不替她宣布"答过了"。
  try {
    const marked = await setQuestionStatus(store, statusKey, 'observed')
    if (!marked?.ok) log?.(`梦做成了，但问题状态没改成 observed：${marked?.reason || '未知原因'}`)
  } catch (e) {
    log?.(`梦做成了，但问题状态没改成 observed：${e?.message || e}`)
  }

  log?.(`做成一个梦：${clip(thread, 30)}`)
  return { ok: true, event, dream: meta }
}
