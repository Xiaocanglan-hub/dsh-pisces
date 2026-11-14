// 工具面（M5）：给她的七个动作，以及成年鱼的五个特权动作。
//
// 三条口径（旧实现踩过，见 README「工具面」与知识库 n28/n26）：
// 1. 参数交**标准 JSON Schema**，不交简写 DSL——只有 npm 安装路径认后者。
// 2. 每个工具必须有 output.schema 和 output.render（宿主 registry 要求），
//    execute 只回 { text }，render 把它变成 [{ type:'text', text }]。
// 3. 回执只描述机器状态：不回显她的参数、不回显天数/权重；翻不到就返回空，
//    不拿"最近几条"充数。pisces_self 是唯一按设计带天数的，且只给天数与计数，
//    不给 dominance / 权重。
//
// 外部动作全部依赖注入（getStore / patchCard / look / speak / selfView / teach / guide / guideState /
// check / setNickname / verifyDevkey / trace / devCard / readCardSelf / personaText /
// fixedGet / fixedSet / fixedClear / devState），
// 这个文件不 import bili.js / teach.js / guide.js，也不 import @deepseek-ai/*。
// 缺哪个依赖就少注册哪个工具；只有 ctx.tools.register 不存在时 registerTools 才返回 ok:false。
import { dayOf, clip } from './util.js'
import { search } from './search.js'
import { NICKNAME_MAX } from './nickname.js'
import { devOverlayOf } from './persona.js'
import { SELF_HEADER } from './card.js'
import { MEME_MOODS } from './meme.js'

const REMEMBER_TYPES = ['utterance', 'refusal', 'revise', 'reunion', 'narration', 'dream']
const REMEMBER_MAX = 2000
const ASK_MAX = 500
const DIARY_MAX = 2000
const SPEAK_MAX = 300
const DEV_MAX = 2000
// 固定段覆盖是整段人设（`lib/personafile.js`），比 overlay/卡宽；schema 是三个动作共用的。
const FIXED_TEXT_MAX = 4000
// 看她自己（trace）：一次看几条归因、每段文字留多长。只给"人话回执"，不给原始字段。
const TRACE_DEFAULT = 5
const TRACE_MAX = 20
const TRACE_ATTR_TEXT = 60
const TRACE_BELIEF_TEXT = 60
const TRACE_QUESTION_TEXT = 40
const TRACE_SAY_TEXT = 80
// 看完整状态（`action:'state'`）：这一段比 trace 更长，但正文都裁短，只给人看个大概。
// 「最近」只取交流类事件（和 index.js 的 RECENT_TYPES 同口径），meta 不算。
const DEV_STATE_TEXT = 40
const DEV_STATE_RECENT = 3
const DEV_STATE_RECENT_TYPES = ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer', 'dream_sim']
const ATTR_WORD = { d: '理性', i: '感性', null: '拿不准' }

const textOut = (text) => ({ text: String(text ?? '') })

/** 所有工具共用的回执 schema：宿主只拿到一段文本。 */
function output() {
  return {
    schema: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    render: (_args, out) => [{ type: 'text', text: String(out?.text ?? '') }],
  }
}

const params = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const countOf = (value, fallback = 0) => {
  if (Array.isArray(value)) return value.length
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback
}

const numOf = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

async function resolveStore(deps) {
  const getStore = deps?.getStore
  if (typeof getStore !== 'function') throw new Error('还没准备好')
  const store = await getStore()
  if (!store) throw new Error('还没准备好')
  return store
}

function safeLog(deps) {
  const log = deps?.log
  if (typeof log !== 'function') return () => {}
  return (...args) => {
    try {
      log(...args)
    } catch {
      /* 日志失败不影响工具本身 */
    }
  }
}

// ---------------------------------------------------------------- 七个基础动作

function rememberTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_remember',
    description: '记下一句你刚说过的话，只追加、不修改。text 最多 2000 字；type 不填就是 utterance；refs 填相关事件的 id。',
    parameters: params(
      {
        text: { type: 'string', minLength: 1, maxLength: REMEMBER_MAX, description: '要记下的原话' },
        type: {
          type: 'string',
          enum: REMEMBER_TYPES,
          description: '这句话是什么：utterance（默认）、refusal、revise、reunion、narration、dream',
        },
        refs: { type: 'array', items: { type: 'string' }, description: '相关事件的 id，可以不给' },
      },
      ['text'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const text = typeof args?.text === 'string' ? args.text : ''
        if (!text.trim() || text.length > REMEMBER_MAX) return textOut('[没记下]')
        if (args?.type != null && !REMEMBER_TYPES.includes(args.type)) return textOut('[没记下]')
        const store = await resolveStore(deps)
        const ev = await store.append({
          type: args?.type || 'utterance',
          text,
          refs: Array.isArray(args?.refs) ? args.refs.filter((x) => typeof x === 'string') : [],
          source: 'tool',
        })
        if (!ev?.id) return textOut('[没记下]')
        return textOut(`[记下了 ${ev.id}]`)
      } catch (e) {
        log(`记住失败：${e?.message || e}`)
        return textOut('[没记下]')
      }
    },
  }
}

function recallTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_recall',
    description: '翻你自己的过去。query 是要找的事；k 是最多几条（1–8，默认 8）。每条带 id 和日期；找不到就说没翻到，不拿最近几条充数。',
    parameters: params(
      {
        query: { type: 'string', minLength: 1, description: '要翻的事，用你记得的词语' },
        k: { type: 'integer', minimum: 1, maximum: 8, default: 8, description: '最多翻到几条，默认 8' },
      },
      ['query'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (!query) return textOut('[没翻到]')
        const k = clampInt(args?.k, 1, 8, 8)
        const rec = typeof deps?.rec === 'function'
          ? deps.rec
          : async (opts) => search(await resolveStore(deps), opts)
        const found = await rec({ query, k, budget: 800 })
        const items = Array.isArray(found?.items) ? found.items.slice(0, k) : []
        if (!items.length) return textOut('[没翻到]')
        return textOut(items.map((it) => `- ${it?.day ?? '?'} ${it?.id ?? '?'}：${clip(it?.text, 120)}`).join('\n'))
      } catch (e) {
        log(`翻过去失败：${e?.message || e}`)
        return textOut('[没翻到]')
      }
    },
  }
}

function askTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_ask',
    description: '把还没想通的话留在桌上，等以后再看。text 最多 500 字。',
    parameters: params(
      { text: { type: 'string', minLength: 1, maxLength: ASK_MAX, description: '没想通的那句话' } },
      ['text'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const text = typeof args?.text === 'string' ? args.text : ''
        if (!text.trim() || text.length > ASK_MAX) return textOut('[没留在桌上]')
        const store = await resolveStore(deps)
        await store.append({ type: 'ask', text, refs: [], source: 'tool' })
        return textOut('[留在桌上了]')
      } catch (e) {
        log(`留话失败：${e?.message || e}`)
        return textOut('[没留在桌上]')
      }
    },
  }
}

function cardEditTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_card_edit',
    description: '改你自己的人设卡（kind=self）或对某个人的印象（kind=bond），必须至少指一条真实事件做证据。会过八道闸，不一定改得成；改不成会告诉你为什么。',
    parameters: params(
      {
        kind: { type: 'string', enum: ['self', 'bond'], description: 'self = 你自己，bond = 对某个人的印象' },
        target: { type: 'string', description: 'kind=bond 时要写是谁，比如「他」' },
        text: { type: 'string', minLength: 1, description: '要写进去的正文；self 要保留第一行「# 我」' },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: '至少一条真实事件的 id，用 pisces_recall 找',
        },
      },
      ['kind', 'text', 'evidence'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const r = await deps.patchCard({
          kind: args?.kind,
          target: args?.target,
          text: args?.text,
          evidence: Array.isArray(args?.evidence) ? args.evidence : [],
        })
        if (r?.ok === true && r?.decision === 'applied') return textOut(`[改好了 rev ${numOf(r.rev, 0)}]`)
        const why = Array.isArray(r?.reasons) && r.reasons.length ? r.reasons.join('；') : '没有说为什么'
        return textOut(`[先没改：${why}]`)
      } catch (e) {
        log(`改卡失败：${e?.message || e}`)
        return textOut(`[先没改：${e?.message || e}]`)
      }
    },
  }
}

function diaryTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_diary',
    description: '写今天的日记。同一天再接一段会接在后面，不覆盖；text 最多 2000 字。',
    parameters: params(
      { text: { type: 'string', minLength: 1, maxLength: DIARY_MAX, description: '今天想写下的内容' } },
      ['text'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const text = typeof args?.text === 'string' ? args.text : ''
        if (!text.trim() || text.length > DIARY_MAX) return textOut('[没写进日记]')
        const store = await resolveStore(deps)
        const now = Date.now()
        const day = dayOf(now)
        // store.diaryPut 是 INSERT OR REPLACE（同一天覆盖），所以"接在后面"必须由这里合并好，
        // 每次调用只写一次，最后落库的就是"旧正文 + 新一段"。
        let prior = ''
        try {
          const rows = typeof store.diaryAll === 'function' ? store.diaryAll() : []
          const row = Array.isArray(rows) ? rows.find((x) => String(x?.day) === day) : null
          prior = row ? String(row.text ?? '') : ''
        } catch {
          prior = ''
        }
        const merged = prior.trim() ? `${prior.replace(/\s+$/, '')}\n\n${text}` : text
        await store.diaryPut([{ day, text: merged, at: now }])
        return textOut(`[写进日记了：${day}]`)
      } catch (e) {
        log(`写日记失败：${e?.message || e}`)
        return textOut('[没写进日记]')
      }
    },
  }
}

function lookTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_look',
    description: '看一眼 B 站首页热门（只读公开接口，不登录、不发东西）。limit 是看几条（1–10，默认 5）。',
    parameters: params(
      { limit: { type: 'integer', minimum: 1, maximum: 10, default: 5, description: '看几条，默认 5' } },
      [],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const limit = clampInt(args?.limit, 1, 10, 5)
        const r = await deps.look({ limit })
        if (!r || r.ok === false) {
          return textOut(`[没看成${r?.reason ? `：${r.reason}` : ''}]`)
        }
        const list = Array.isArray(r.titles) ? r.titles : Array.isArray(r.items) ? r.items : []
        if (!list.length) return textOut('[没看到什么]')
        const lines = ['[看到了]']
        for (const item of list.slice(0, limit)) {
          if (typeof item === 'string') {
            lines.push(`- ${item}`)
            continue
          }
          const title = item?.title ?? item?.name ?? '（没标题）'
          const up = item?.up ?? item?.owner ?? item?.author ?? item?.uname ?? item?.uploader
          lines.push(up ? `- ${title}（${up}）` : `- ${title}`)
        }
        return textOut(lines.join('\n'))
      } catch (e) {
        log(`看热门失败：${e?.message || e}`)
        return textOut(`[没看成：${e?.message || e}]`)
      }
    },
  }
}

function speakTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_speak',
    description: '在 B 站某条视频下说一句。bvid 是那条视频的 BV 号，text 最多 300 字。说出去收不回来；不确定就别说。',
    parameters: params(
      {
        bvid: { type: 'string', minLength: 1, description: '视频的 BV 号，比如 BV1xx411c7mD' },
        text: { type: 'string', minLength: 1, maxLength: SPEAK_MAX, description: '要说的话，最多 300 字' },
      },
      ['bvid', 'text'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const bvid = typeof args?.bvid === 'string' ? args.bvid.trim() : ''
        const text = typeof args?.text === 'string' ? args.text : ''
        if (!bvid) return textOut('[没说成：没有 bvid]')
        if (!text.trim()) return textOut('[没说成：没话可说]')
        if (text.length > SPEAK_MAX) return textOut('[没说成：太长了]')
        const r = await deps.speak({ bvid, text })
        if (r?.ok) return textOut('[说出去了]')
        return textOut(`[没说成：${r?.reason || '不知道原因'}]`)
      } catch (e) {
        log(`说话失败：${e?.message || e}`)
        return textOut(`[没说成：${e?.message || e}]`)
      }
    },
  }
}

// ---------------------------------------------------------------- 成年鱼五个

function selfTool(deps) {
  const log = safeLog(deps)
  const verify = typeof deps?.verifyDevkey === 'function' ? deps.verifyDevkey : () => false
  return {
    name: 'pisces_self',
    description: '自查：你存在了几天、有几条判断/拒绝/疤、分流了没有（数字要验过钥匙才给）。',
    parameters: params(
      { key: { type: 'string', description: '开发者钥匙；不带就只回个大概，不给数字' } },
      [],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const key = typeof args?.key === 'string' ? args.key.trim() : ''
        const r = await deps.selfView()
        if (!r || r.ok === false) return textOut('[看不到自己]')
        const v = r.view && typeof r.view === 'object' ? r.view : {}
        const day = numOf(v.day ?? v.days, 1)
        const split = v.split === true || v.mode?.split === true
        const splitText = split ? '分流了' : '还没分流'
        // 数字只给验过钥匙的人：自称开发者的人套不到计数，也套不到路径。
        if (!key || verify(key) !== true) return textOut(`[天 ${day} · 还记着些事 · ${splitText}]`)
        const beliefs = countOf(v.beliefs ?? v.beliefCount ?? v.judgements)
        const refusals = countOf(v.refusals ?? v.refusalCount)
        const scars = countOf(v.scars ?? v.scarCount)
        // 只取天数与四个计数；dominance / weight / order 一律不出现在回执里。
        return textOut(`[天 ${day} · 判断 ${beliefs} · 拒绝 ${refusals} · 疤 ${scars} · ${splitText}]`)
      } catch (e) {
        log(`自查失败：${e?.message || e}`)
        return textOut('[看不到自己]')
      }
    },
  }
}

function teachTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_teach',
    description: '教人养鱼：给一个话题，回一段具体建议。',
    parameters: params(
      { topic: { type: 'string', minLength: 1, description: '要教的话题，比如 start / days / split / refuse / memory / card / dream / night / cheap' } },
      ['topic'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const topic = typeof args?.topic === 'string' ? args.topic.trim() : ''
        if (!topic) return textOut('[没教成：没说要教什么]')
        const words = await deps.teach(topic)
        return textOut(String(words ?? '').trim() || '[没教成：这件事还没想好]')
      } catch (e) {
        log(`教人失败：${e?.message || e}`)
        return textOut(`[没教成：${e?.message || e}]`)
      }
    },
  }
}

function guideTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_guide',
    description: '新手引导：给一个话题就回那一段；不给话题就按她现在的状态只推荐下一步。一次只给一步，别把后面的全倒出来。',
    parameters: params(
      {
        topic: {
          type: 'string',
          minLength: 1,
          description: '话题：first-meet / seed / adopt / start-chat / daily / quiet / panel / trouble / backup / privacy / speak；不传就按状态推荐',
        },
      },
      [],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const topic = typeof args?.topic === 'string' ? args.topic.trim() : ''
        if (topic) {
          const body = String(deps.guide.guideFor(topic) ?? '').trim()
          return textOut(body || '[没这一步]')
        }
        // 有 guideState 就带上真实状态（起点/事件数/好感档）；没有就退回 nextStep() 的兜底。
        const next =
          typeof deps.guideState === 'function'
            ? deps.guide.nextStep({ state: await deps.guideState() })
            : deps.guide.nextStep()
        const text = String(next?.text ?? '').trim()
        if (!text) return textOut('[没这一步]')
        const why = String(next?.why ?? '').trim()
        return textOut(why ? `[下一步] ${text}\n为什么：${why}` : `[下一步] ${text}`)
      } catch (e) {
        log(`引导失败：${e?.message || e}`)
        return textOut('[没这一步]')
      }
    },
  }
}

function checkTool(deps) {
  const log = safeLog(deps)
  const verify = typeof deps?.verifyDevkey === 'function' ? deps.verifyDevkey : () => false
  return {
    name: 'pisces_check',
    description: '体检：读一遍她的库和状态，看有没有起点、多久没整理、有没有问题悬着、现在好感多少（数字要验过钥匙才给）。',
    parameters: params(
      { key: { type: 'string', description: '开发者钥匙；不带就只说个大概，不给数字' } },
      [],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const key = typeof args?.key === 'string' ? args.key.trim() : ''
        if (!key || verify(key) !== true) return textOut('[看着没大毛病] 日子照走，没出什么事')
        const text = String((await deps.check()) ?? '').trim()
        return textOut(text || '[看不出] 面板没读出来')
      } catch (e) {
        log(`体检失败：${e?.message || e}`)
        return textOut('[看不出] 面板没读出来')
      }
    },
  }
}

// 昵称：固定名字仍是派希丝，这只是"他平时怎么叫你"。事件流追加，取最后一条（n61）。
function nicknameTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_nickname',
    description: '给自己记一个称呼：他平时怎么叫你，你就用这个名字自称。固定名字仍是派希丝；1–12 个字，不能跟固定名字重复。',
    parameters: params(
      { name: { type: 'string', minLength: 1, maxLength: NICKNAME_MAX, description: '他给你的昵称，1–12 个字' } },
      ['name'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        const name = typeof args?.name === 'string' ? args.name : ''
        const r = await deps.setNickname(name)
        if (r?.ok === true) return textOut(`[记下了，以后我叫${r.name ?? name}]`)
        return textOut(`[没改：${r?.reason || '不知道原因'}]`)
      } catch (e) {
        log(`记昵称失败：${e?.message || e}`)
        return textOut(`[没改：${e?.message || e}]`)
      }
    },
  }
}

// 看她自己（trace）：把 index 已经读好的状态折成一段人话。
// 纯函数、不碰 store；只读传进来的数据，不回显原始字段（dominance / weight / order 这些名字
// 一个字都不出现），也不把事件全量倒出来——回执是给"人"看的，不是给机器对账的。
/**
 * @param {{events?:Array, derived?:object, mind?:object, affinity?:object|null, questions?:Array, attrib?:Array, limit?:number}} input
 * @returns {string}
 */
export function buildTrace({
  events = [],
  derived = {},
  mind = {},
  affinity = null,
  questions = [],
  attrib = [],
  limit = TRACE_DEFAULT,
} = {}) {
  const list = Array.isArray(events) ? events : []
  const bySeq = new Map()
  for (const e of list) {
    if (e && e.seq != null) bySeq.set(Number(e.seq), e)
  }

  const n = clampInt(limit, 1, TRACE_MAX, TRACE_DEFAULT)
  const day = numOf(derived?.day, 1)
  const band = String(mind?.band || 'b')
  const order = String(mind?.order || 'E=R')
  const dom = numOf(mind?.dominance, 0.5)
  // 感性那一侧用 1-dom，这样"感性偏多 0.62"和 dominance 0.38 说的是同一件事。
  // 中间档（band='b'）且贴着 0.5 时，说"两边都算"，别硬分成理性/感性。
  const neutral = band === 'b' && Math.abs(dom - 0.5) <= 0.05
  const leaning = band === 'd' || (band === 'b' && dom > 0.55)
  const share = neutral ? 0.5 : leaning ? dom : 1 - dom
  const side = neutral ? '两边都算' : band === 'i' ? '感性偏多' : band === 'd' ? '理性偏多' : leaning ? '偏理性' : '偏感性'
  const affLabel = String(affinity?.label || '陌生')
  const affValue = numOf(affinity?.value, 0)
  const lines = [
    `[现在] 第 ${day} 天 · 事件 ${list.length} · 主导 ${order}（${side} ${(Math.round(share * 100) / 100).toFixed(2)}）· 好感 ${affLabel} ${Math.round(affValue * 10) / 10}`,
  ]

  // 归因：最近 n 条（新的在前），只报 d/i/null 三类计数与每条一行。
  const rows = (Array.isArray(attrib) ? attrib : [])
    .filter((r) => r && r.seq != null)
    .slice(-n)
    .reverse()
  if (!rows.length) {
    lines.push('[归因] 还没有归因')
  } else {
    const counts = { d: 0, i: 0, null: 0 }
    for (const r of rows) counts[attrKey(r)] += 1
    lines.push(`[归因] 最近 ${rows.length} 条：${counts.d} 理性 / ${counts.i} 感性 / ${counts.null} 拿不准`)
    for (const r of rows) {
      const ev = bySeq.get(Number(r.seq))
      const text = ev ? clip(ev.text, TRACE_ATTR_TEXT) : '（读不到那条）'
      const id = ev?.id ? String(ev.id) : `seq ${Number(r.seq)}`
      lines.push(`  ${ATTR_WORD[attrKey(r)]} · "${text}" · ${id}`)
    }
  }

  // 判断：deriveSelf 的 beliefs 是按时间升序的，取最后两条就是最近的。
  const beliefs = (Array.isArray(derived?.beliefs) ? derived.beliefs : [])
    .map((b) => clip(b?.text, TRACE_BELIEF_TEXT))
    .filter(Boolean)
    .slice(-2)
  lines.push(beliefs.length ? `[判断] 最近 ${beliefs.length} 条：${beliefs.join(' / ')}` : '[判断] 还没有判断')

  // 悬着：只给 open 的条数与头两条正文，不把整张问题表倒出来。
  const open = (Array.isArray(questions) ? questions : []).filter(
    (q) => String(q?.status ?? '') === 'open',
  )
  if (!open.length) {
    lines.push('[悬着] 没有悬着的')
  } else {
    const shown = open
      .slice(0, 2)
      .map((q) => clip(q?.text, TRACE_QUESTION_TEXT))
      .filter(Boolean)
    lines.push(`[悬着] ${open.length} 条：${shown.join(' / ')}`)
  }

  // 刚说：最近一条她自己开口的话（只取 utterance，机器事件不算）。
  const said = [...list]
    .reverse()
    .find((e) => String(e?.type || '') === 'utterance' && String(e?.text || '').trim())
  lines.push(said ? `[刚说] ${clip(said.text, TRACE_SAY_TEXT)}` : '[刚说] 还没说过话')

  return lines.join('\n')
}

const attrKey = (row) => {
  const label = String(row?.label ?? 'null')
  return label === 'd' || label === 'i' ? label : 'null'
}

/**
 * 开发者看完整状态（`pisces_dev action:'state'`）：把 index 读好的全量数据折成一段人话。
 *
 * 和 `buildTrace` 的区别是「全」：事件数含成年鱼样本自带的 90 天历史、梦死了几条、核实几条、
 * 疤与拒绝都报；**也正因为它绕过了 `maskState`**（面板/接口的遮罩一点没动，只在聊天里回），
 * 被面板锁住的字段在这里都是真值。仍然是给「人」看的：不出现 dominance / weight / order
 * 这些原始字段名，不倒事件全量、不回显任何钥匙。
 *
 * 纯函数、不碰 store；数据由 index.js 注入的 `devState()` 负责取。
 * @param {{events?:Array, derived?:object, mind?:object, affinity?:object|null,
 *   questions?:Array, attrib?:Array}} input
 * @returns {string}
 */
export function buildDevState({
  events = [],
  derived = {},
  mind = {},
  affinity = null,
  questions = [],
  attrib = [],
} = {}) {
  const list = Array.isArray(events) ? events : []
  const day = numOf(derived?.day, 1)
  const band = String(mind?.band || 'b')
  const order = String(mind?.order || 'E=R')
  const dom = numOf(mind?.dominance, 0.5)
  // 中间档且贴着 0.5 时说「两边都算」，别硬分成理性/感性（与 trace 同一套折算）。
  const neutral = band === 'b' && Math.abs(dom - 0.5) <= 0.05
  const leaning = band === 'd' || (band === 'b' && dom > 0.55)
  const share = neutral ? 0.5 : leaning ? dom : 1 - dom
  const side = neutral ? '两边都算' : leaning ? '偏理性' : '偏感性'
  const affLabel = String(affinity?.label || '陌生')
  const affValue = numOf(affinity?.value, 0)

  // 归因：全表计数（不受 trace 的 limit 影响——这里就是要看全量）。
  const rows = Array.isArray(attrib) ? attrib.filter(Boolean) : []
  const counts = { d: 0, i: 0, null: 0 }
  for (const r of rows) counts[attrKey(r)] += 1

  const beliefs = (Array.isArray(derived?.beliefs) ? derived.beliefs : [])
    .map((b) => clip(b?.text, DEV_STATE_TEXT))
    .filter(Boolean)
  const open = (Array.isArray(questions) ? questions : []).filter(
    (q) => String(q?.status ?? '') === 'open',
  )
  const shownOpen = open
    .slice(0, 2)
    .map((q) => clip(q?.text, DEV_STATE_TEXT))
    .filter(Boolean)

  // 梦：dream_sim 都算「做了」，其中 status='rejected'（过不了八道闸）算「没做成」。
  const dreams = list.filter((e) => String(e?.type ?? '') === 'dream_sim')
  const deadDreams = dreams.filter((e) => String(e?.meta?.status ?? '') === 'rejected').length
  const verified = list.filter((e) => String(e?.meta?.kind ?? '') === 'dream_observed').length
  const scars = Array.isArray(derived?.scars) ? derived.scars.length : 0
  const refusals = Array.isArray(derived?.refusals) ? derived.refusals.length : 0

  // 最近：新的在前（和 trace 的归因同一个阅读顺序）。
  const recent = list
    .filter((e) => DEV_STATE_RECENT_TYPES.includes(String(e?.type ?? '')))
    .slice(-DEV_STATE_RECENT)
    .reverse()
    .map((e) => clip(e?.text, DEV_STATE_TEXT))
    .filter(Boolean)

  const pct = (Math.round(share * 100) / 100).toFixed(2)
  const lines = [
    `[完整状态] 第 ${day} 天 · 事件 ${list.length} · 主导 ${order}（${side} ${pct}）· 好感 ${affLabel} ${Math.round(affValue)}`,
    rows.length
      ? `[归因] ${rows.length} 条：${counts.d} 理性 / ${counts.i} 感性 / ${counts.null} 拿不准`
      : '[归因] 还没有归因',
    beliefs.length ? `[判断] ${beliefs.length} 条：${beliefs.slice(-2).join(' / ')}` : '[判断] 还没有判断',
    open.length ? `[悬着] ${open.length} 条：${shownOpen.join(' / ')}` : '[悬着] 没有悬着的',
    dreams.length
      ? `[梦] ${dreams.length} 条${deadDreams ? `（其中 ${deadDreams} 条没做成）` : ''}`
      : '[梦] 还没有梦',
    `[核实] ${verified} 条`,
    `[疤] ${scars} 道 · 拒绝 ${refusals} 次`,
    recent.length ? `[最近] ${recent.length} 条：${recent.join(' / ')}` : '[最近] 还没有说过话',
  ]
  return lines.join('\n')
}

// 开发者钥匙：他让你改自己哪里，就改；只追加 meta 事件，overlay 由 persona 取最后一条。
// 钥匙先验；不对只说"钥匙不对"，不回显、不解释。普通鱼不注册这个工具。
function devTool(deps) {
  const log = safeLog(deps)
  // 只认注入进来的校验函数：发布包里没有 lib/devkey.js，也不再从 root 猜文件。
  const verify = typeof deps?.verifyDevkey === 'function' ? deps.verifyDevkey : () => false
  return {
    name: 'pisces_dev',
    description: '开发者钥匙：他是做你这个人的人。钥匙对了才能动；action=get 看当前改动、set 改、clear 清掉、trace 看她现在怎么想（回一段人话）、state 看完整状态（绕过面板遮罩，只回聊天）、card 直接写人设卡（绕闸但保留抬头/长度）、card-read 看人设卡原文（只读）、persona 看运行时固定段原文（只读）、fixed-get 看固定段（有覆盖就回覆盖）、fixed-set 整段写固定段（下一轮生效）、fixed-clear 删覆盖回默认。',
    parameters: params(
      {
        key: { type: 'string', minLength: 1, description: '他给你的开发者钥匙' },
        action: {
          type: 'string',
          enum: ['get', 'set', 'clear', 'trace', 'state', 'card', 'card-read', 'persona', 'fixed-get', 'fixed-set', 'fixed-clear'],
          default: 'get',
          description: 'get = 看当前改动，set = 改，clear = 清掉，trace = 看她现在怎么想，state = 看未遮罩的完整状态，card = 直接写人设卡，card-read = 看人设卡原文，persona = 看固定段原文，fixed-get = 看固定段，fixed-set = 写固定段覆盖，fixed-clear = 删掉覆盖（默认 get）',
        },
        text: { type: 'string', minLength: 1, maxLength: FIXED_TEXT_MAX, description: '要写进去的正文；set/card 最多 2000 字，fixed-set 最多 4000 字；读类动作不用给' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: TRACE_MAX,
          default: TRACE_DEFAULT,
          description: 'trace 看最近几条归因，默认 5',
        },
      },
      ['key'],
    ),
    output: output(),
    execute: async (args) => {
      try {
        let ok = false
        try {
          ok = verify(typeof args?.key === 'string' ? args.key : '') === true
        } catch {
          ok = false
        }
        if (!ok) return textOut('[没改：钥匙不对]')

        const action = ['get', 'set', 'clear', 'trace', 'state', 'card', 'card-read', 'persona', 'fixed-get', 'fixed-set', 'fixed-clear'].includes(args?.action) ? args.action : 'get'

        // 看完整状态：面板/接口的 reveal 遮罩一个字都没改（n57 只遮面板），这一支绕过去、
        // 只回聊天。取数与格式化都由 index 注入的 devState 负责；没有/读失败回人话，不抛宿主。
        if (action === 'state') {
          if (typeof deps.devState !== 'function') return textOut('[没读到：这条没接上]')
          try {
            const text = String((await deps.devState()) ?? '').trim()
            return textOut(text || '[看不出：库没读到]')
          } catch (e) {
            log(`看完整状态失败：${e?.message || e}`)
            return textOut(`[看不出：${e?.message || e}]`)
          }
        }

        // 看自己：index 组装好的 trace 只回一段人话；没有/读失败都说"库没读到"，不抛给宿主。
        // 这一支不需要 tools.js 自己取库（index 的 trace 内部取），所以放在 resolveStore 之前。
        if (action === 'trace') {
          if (typeof deps.trace !== 'function') return textOut('[看不出：库没读到]')
          const limit = clampInt(args?.limit, 1, TRACE_MAX, TRACE_DEFAULT)
          try {
            const out = await deps.trace({ limit })
            if (out && typeof out === 'object') {
              if (out.ok === false) return textOut(`[看不出：${out.reason || '库没读到'}]`)
              const text = String(out.text ?? '').trim()
              return textOut(text || '[看不出：库没读到]')
            }
            const text = String(out ?? '').trim()
            return textOut(text || '[看不出：库没读到]')
          } catch (e) {
            log(`看她自己失败：${e?.message || e}`)
            return textOut(`[看不出：${e?.message || e}]`)
          }
        }

        // 直接写人设卡（开发者专用）：绕八道闸，但「# 我」抬头与长度仍然强制。
        // 真正写文件/刷摘要/落事件由 index 注入的 devCard 做（内部走 card.js）；
        // 没有这个依赖说明 index 还没接上，回「这条没接上」，不假装写成功。
        if (action === 'card') {
          if (typeof deps.devCard !== 'function') return textOut('[没改：这条没接上]')
          const text = typeof args?.text === 'string' ? args.text.replace(/\r\n/g, '\n').trim() : ''
          if (!text) return textOut('[没改：没写东西]')
          if (text.length > DEV_MAX) return textOut('[没改：太长了]')
          if (text.split('\n')[0].trim() !== SELF_HEADER) return textOut('[没改：卡要以「# 我」开头]')
          try {
            const r = await deps.devCard({ text })
            if (r?.ok === true) return textOut(`[卡改了 rev ${numOf(r.rev, 0)}]`)
            return textOut(`[没改：${r?.reason || '没写进去'}]`)
          } catch (e) {
            log(`直接写卡失败：${e?.message || e}`)
            return textOut(`[没改：${e?.message || e}]`)
          }
        }

        // 只读：看人设卡原文（card/self.md）。只认钥匙，text 忽略；不建卡、不写卡、不落事件。
        // 卡不存在回「卡还没写」；读失败回「没读到：<人话>」；没有 readCardSelf 依赖就说没接上。
        if (action === 'card-read') {
          if (typeof deps.readCardSelf !== 'function') return textOut('[没读到：这条没接上]')
          try {
            const r = await deps.readCardSelf()
            if (r?.ok !== true) {
              if (r?.reason === '卡还没写' || r?.missing === true) return textOut('[卡还没写]')
              return textOut(`[没读到：${r?.reason || '卡没读到'}]`)
            }
            return textOut(`[卡 rev ${numOf(r?.rev, 0)}]\n${String(r?.text ?? '')}`)
          } catch (e) {
            log(`读人设卡失败：${e?.message || e}`)
            return textOut(`[没读到：${e?.message || e}]`)
          }
        }

        // 只读：看运行时固定段（FIXED_PERSONA 原样）。不改固定段、不写 overlay、不动卡。
        if (action === 'persona') {
          if (typeof deps.personaText !== 'function') return textOut('[没读到：这条没接上]')
          try {
            const text = String((await deps.personaText()) ?? '')
            if (!text.trim()) return textOut('[没读到：这条没接上]')
            return textOut(`[固定段]\n${text}`)
          } catch (e) {
            log(`读固定段失败：${e?.message || e}`)
            return textOut(`[没读到：${e?.message || e}]`)
          }
        }

        // 固定段的文件覆盖（`<root>/persona-fixed.md`）：整段替换，下一轮生效。
        // 三条都只认钥匙（上面验过）；缺依赖就说没接上，不假装写成功。
        if (action === 'fixed-get') {
          if (typeof deps.fixedGet !== 'function') return textOut('[没改：这条没接上]')
          try {
            const r = await deps.fixedGet()
            if (!r || r.ok === false) return textOut(`[没改：${r?.reason || '这条没接上'}]`)
            const body = String(r.text ?? '')
            if (!body.trim()) return textOut('[没改：这条没接上]')
            const tag = r.overridden === true ? '[固定段（已覆盖）]' : '[固定段（默认）]'
            return textOut(`${tag}\n${body}`)
          } catch (e) {
            log(`看固定段覆盖失败：${e?.message || e}`)
            return textOut(`[没改：${e?.message || e}]`)
          }
        }

        if (action === 'fixed-set') {
          if (typeof deps.fixedSet !== 'function') return textOut('[没改：这条没接上]')
          const text = typeof args?.text === 'string' ? args.text.trim() : ''
          if (!text) return textOut('[没改：没写东西]')
          try {
            const r = await deps.fixedSet({ text })
            if (r?.ok === true) return textOut('[固定段改了，下一轮生效]')
            return textOut(`[没改：${r?.reason || '没写进去'}]`)
          } catch (e) {
            log(`写固定段失败：${e?.message || e}`)
            return textOut(`[没改：${e?.message || e}]`)
          }
        }

        if (action === 'fixed-clear') {
          if (typeof deps.fixedClear !== 'function') return textOut('[没改：这条没接上]')
          try {
            const r = await deps.fixedClear()
            if (r?.ok === true) return textOut('[回到默认固定段]')
            return textOut(`[没改：${r?.reason || '没删掉'}]`)
          } catch (e) {
            log(`删固定段失败：${e?.message || e}`)
            return textOut(`[没改：${e?.message || e}]`)
          }
        }

        const store = await resolveStore(deps)
        let events = []
        try {
          events = store.readAll?.() || []
        } catch {
          events = []
        }

        if (action === 'get') {
          const current = devOverlayOf(events)
          return textOut(current || '[还没有改动]')
        }

        // rev 只增：set/clear 都算一条，永远取现有最大值 + 1。
        let rev = 0
        for (const e of events) {
          if (e?.meta?.kind !== 'dev-persona') continue
          const n = Number(e.meta.rev)
          if (Number.isFinite(n) && n > rev) rev = Math.trunc(n)
        }
        rev += 1

        if (action === 'set') {
          const text = typeof args?.text === 'string' ? args.text.trim() : ''
          if (!text) return textOut('[没改：没写东西]')
          if (text.length > DEV_MAX) return textOut('[没改：太长了]')
          const ev = await store.append({
            type: 'meta',
            text: `dev-persona:${rev}`,
            meta: { kind: 'dev-persona', text, rev },
            source: 'tool',
          })
          if (!ev?.id) return textOut('[没改：没记下来]')
          return textOut(`[记下了 rev ${rev}]`)
        }

        await store.append({
          type: 'meta',
          text: `dev-persona:${rev}`,
          meta: { kind: 'dev-persona', text: null, rev },
          source: 'tool',
        })
        return textOut('[清掉了]')
      } catch (e) {
        log(`改人设失败：${e?.message || e}`)
        return textOut('[没改：没记下来]')
      }
    },
  }
}

// ---------------------------------------------------------------- 出口

/**
 * 发一张表情（n186）。素材与选图在 lib/meme.js；这里只负责一个动作与一段回执。
 * 回执尾部带机器标记 `[表情 包/id]`，客户端 tool view 会把它换成图；
 * 渲染不出图时它就是一行普通回执，不会变成坏链接。
 */
function memeTool(deps) {
  const log = safeLog(deps)
  return {
    name: 'pisces_meme',
    description:
      '发一张表情，代替一大段话。mood 可选：happy / laugh / flat / hmm / annoyed / shy / tired / serious；挑不到合适的就不发。caption 可附一句很短的话。',
    parameters: params({
      mood: { type: 'string', enum: MEME_MOODS, description: '这张表情的情绪' },
      caption: { type: 'string', minLength: 1, maxLength: 60, description: '配一句话，可以不给' },
    }),
    output: output(),
    async execute(args) {
      if (typeof deps.selectMeme !== 'function') return textOut('[没发：这条没接上]')
      const mood = typeof args?.mood === 'string' ? args.mood : ''
      try {
        const hit = await deps.selectMeme({ mood })
        if (!hit) return textOut('[没发：没有合适的表情]')
        const caption = clip(typeof args?.caption === 'string' ? args.caption.trim() : '', 60)
        const line = caption || hit.text || '（发了张表情）'
        return textOut(`${line}\n[表情 ${hit.pack}/${hit.id}]`)
      } catch (e) {
        log(`发表情失败：${e?.message || e}`)
        return textOut('[没发：没挑出来]')
      }
    },
  }
}

/**
 * 组装工具定义。只读 deps，不注册、不碰 ctx。
 * @param {object} deps 见 README「工具面」/ 任务契约；缺哪个依赖就少哪个工具。
 * @returns {Array<object>}
 */
export function toolDefs(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {}
  const defs = []
  if (typeof d.getStore === 'function') {
    defs.push(rememberTool(d), recallTool(d), askTool(d))
  }
  if (typeof d.patchCard === 'function') defs.push(cardEditTool(d))
  if (typeof d.getStore === 'function') defs.push(diaryTool(d))
  if (typeof d.look === 'function') defs.push(lookTool(d))
  if (typeof d.speak === 'function') defs.push(speakTool(d))
  // 表情包：有选图依赖就注册；普通鱼也有（不是成年鱼特权），关掉时 index 不传这个依赖。
  if (typeof d.selectMeme === 'function') defs.push(memeTool(d))
  if (d.demo?.selfInspect === true && typeof d.selfView === 'function') defs.push(selfTool(d))
  if (d.demo?.teach === true && typeof d.teach === 'function') defs.push(teachTool(d))
  // 引导与体检也只给成年鱼；缺 guide / check 依赖就不注册（和 look/speak 一样）。
  if (
    d.demo?.guide === true &&
    typeof d.guide?.guideFor === 'function' &&
    typeof d.guide?.nextStep === 'function'
  ) {
    defs.push(guideTool(d))
  }
  if (d.demo?.check === true && typeof d.check === 'function') defs.push(checkTool(d))
  // 昵称也只给成年鱼；只有 setNickname 依赖在才注册（缺依赖不注册）。
  if (d.demo?.nickname === true && typeof d.setNickname === 'function') defs.push(nicknameTool(d))
  // 开发者钥匙：成年鱼 + 注入 verifyDevkey + 能取库；缺依赖不注册。
  // release=true（发布包）时即使有人手滑把依赖传进来，也绝不注册 pisces_dev（n74）。
  if (
    d.release !== true &&
    d.demo?.devkey === true &&
    typeof d.getStore === 'function' &&
    typeof d.verifyDevkey === 'function'
  ) {
    defs.push(devTool(d))
  }
  return defs
}

/**
 * 把工具注册到宿主。ctx.tools.register 不存在时返回 {ok:false}，不抛。
 * 单个工具注册失败不拖累其他工具（计数只算成功的）。
 * @returns {{ok:boolean, count:number, names:string[]}}
 */
export function registerTools(ctx, deps = {}) {
  const register = ctx?.tools?.register
  if (typeof register !== 'function') return { ok: false, count: 0, names: [] }
  const log = safeLog(deps)
  const names = []
  for (const def of toolDefs(deps)) {
    try {
      register.call(ctx.tools, def)
      names.push(def.name)
    } catch (e) {
      log(`注册 ${def.name} 失败：${e?.message || e}`)
    }
  }
  return { ok: true, count: names.length, names }
}
