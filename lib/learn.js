// 自学（M10）：拿她还悬着的问题去查一次，只把"查来的"素材放进 studies 表。
//
// 搜索这一层是实测出来的（知识库 n13）：
// - 百度对脚本请求回 200 的验证页（h3 数为 0，看着像"没结果"），弃用；
// - 搜狗第二次就 302 到 /antispider/，弃用；
// - 只走 Bing。原句会被 Bing 砍成关键词（"猫为什么会踩奶" 只剩"猫"），先去掉疑问词再搜。
//
// 页面读不到（baike/知乎对脚本 403、验证页、正文太短）时不硬撑：退回搜索摘要，
// 那句话有出处，但标 from:'snippet'——只当"别人说的"。
import { sha256, clip } from './util.js'
import { listQuestions } from './questions.js'

export const LEARN_ENDPOINT = 'https://www.bing.com/search?q='

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const MAX_FACTS = 3
const MIN_FACT_CHARS = 10
const MAX_FACT_CHARS = 80

// 疑问词按"从长到短"排：先切"为什么/怎么样/什么样"，再切"什么/怎么"。
const QUESTION_PHRASES = [
  '为什么', '为啥', '怎么样', '怎么', '怎样', '如何', '什么时候',
  '是不是', '是否', '能不能', '会不会', '可不可以', '有没有', '要不要',
  '什么样', '什么', '哪里', '哪儿', '哪些', '多少', '多久', '多大',
  '谁', '请问', '告诉我', '可能', '能够',
]

// 语气词：只去句尾/句中的这几个，不动"了/的"这类实词。
const PARTICLES = ['吗', '呢', '啊', '呀', '吧', '嘛', '哦', '啦', '呗']

// "会/能"要当情态词去掉（猫会踩奶 → 猫踩奶），但"机会/能力"里的会/能是实词。
// 先把这些词换成占位符，去完再还原，避免把"会议"切成"议"。
const KEEP_WORDS = [
  '会议', '会员', '会计', '会场', '会长', '机会', '社会', '晚会', '大会', '学会', '协会', '工会', '商会', '展会',
  '能力', '能源', '智能', '性能', '功能', '技能', '才能', '本能',
]

const PUNCT = /[？?！!。，,、；;：:""''「」『』《》〈〉（）【】[\]{}…\s\u3000]+/g

/**
 * 去疑问/语气成分，留下实词。"猫为什么会踩奶" → "猫踩奶"。
 * 全被去光（空串、纯疑问词）时退回原句，宁可用原句去搜，也不要空查询。
 */
export function stripQuestion(text) {
  const original = String(text ?? '').trim()
  if (!original) return original

  const saved = []
  let s = original
  for (const w of KEEP_WORDS) {
    if (!s.includes(w)) continue
    // 占位符里带数字，PUNCT 和"会/能"的清理都不会碰它。
    const token = `\u0001${saved.length}\u0001`
    saved.push(w)
    s = s.split(w).join(token)
  }

  for (const w of QUESTION_PHRASES) s = s.split(w).join('')
  s = s.replace(PUNCT, '')
  for (const c of PARTICLES) s = s.split(c).join('')
  for (const c of ['会', '能']) s = s.split(c).join('')

  for (let i = saved.length - 1; i >= 0; i--) s = s.split(`\u0001${i}\u0001`).join(saved[i])

  return s.trim() || original
}

/**
 * 自学的 key：对去疑问词后的句子取 sha256 前 16 位。
 * "猫为什么会踩奶" 和 "猫踩奶" 都是 cd3e4dc3cee7e0c8——与旧库对齐；落库的 question 仍留原句。
 * （questions.questionKey 是另一套：去标点、不去疑问词，别混用。）
 */
export function studyKey(question) {
  return sha256(stripQuestion(question)).slice(0, 16)
}

// ---------------------------------------------------------------------------
// HTML / 正文
// ---------------------------------------------------------------------------

function fromCodePoint(n) {
  try { return String.fromCodePoint(n) } catch { return '' }
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

/** 去 script/style/标签，实体解码，压空白。块级标签收尾补句号，保住句子边界。 */
function cleanText(html) {
  let s = String(html ?? '')
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '。 ')
  s = s.replace(/<[^>]*>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  s = s.replace(/[ \t\r\f\u00a0\u3000]+/g, ' ')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

function titleOf(html) {
  return cleanText(html).replace(/\s+/g, ' ').trim()
}

/** 从 Bing 结果页拿候选：优先 b_algo 区块（带摘要），没有就退前几条外链。 */
export function parseSearchResults(html) {
  const raw = String(html ?? '')
  const out = []
  const seen = new Set()

  const add = (href, titleHtml, snippetHtml = '') => {
    const url = decodeEntities(String(href ?? '').trim())
    if (!/^https?:\/\//i.test(url)) return
    const host = hostOf(url)
    if (!host || /(^|\.)bing\.com$/.test(host) || /(^|\.)microsoft\.com$/.test(host)) return
    if (seen.has(url)) return
    const title = titleOf(titleHtml)
    if (!title || /^https?:\/\//i.test(title)) return
    seen.add(url)
    out.push({ title: clip(title, 120), url, snippet: cleanText(snippetHtml) })
  }

  const blockRe = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi
  let m
  while ((m = blockRe.exec(raw))) {
    const block = m[1]
    const a = block.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
    if (!a) continue
    const p = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)
    add(a[1], a[2], p ? p[1] : '')
  }

  if (!out.length) {
    const aRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    while ((m = aRe.exec(raw)) && out.length < 5) add(m[1], m[2], '')
  }
  return out
}

/** 查询实词：中文取单字 + 二元组（"猫踩奶" → 猫踩/踩奶），英文取长度 >=3 的词。 */
function queryTerms(question) {
  const q = stripQuestion(question)
  const chars = [...q].filter((c) => /[\u4e00-\u9fff]/.test(c))
  const terms = []
  if (chars.length === 1) terms.push(chars[0])
  for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1])
  if (chars.length >= 2 && chars.length <= 10) terms.push(chars.join(''))
  if (!chars.length) {
    for (const w of q.split(/[^A-Za-z0-9]+/)) if (w.length >= 3) terms.push(w.toLowerCase())
  }
  return { query: q, terms: [...new Set(terms)] }
}

/** 按中文句读切；保留句尾标点，方便把问句整句滤掉。 */
function splitSentences(text) {
  return cleanText(text)
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function matchesTerms(s, terms) {
  const low = s.toLowerCase()
  return terms.some((t) => low.includes(String(t).toLowerCase()))
}

/** 一句话能不能当素材：10–80 字、有中文、沾查询实词、不是问句。 */
function usableFact(sentence, terms) {
  const s = String(sentence ?? '')
    .replace(/^[\s\-–—·•*]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  if (/[？?]/.test(s)) return null
  if (/[吗呢]\s*[。！!]?$/.test(s)) return null
  if (/^(问|答|搜索|广告|相关搜索|查看更多)[:：]/.test(s)) return null
  const n = [...s].length
  if (n < MIN_FACT_CHARS || n > MAX_FACT_CHARS) return null
  if (!/[\u4e00-\u9fff]{4,}/.test(s)) return null
  if (!matchesTerms(s, terms)) return null
  return s
}

/** 从一段正文里按原顺序抽最多 limit 句。 */
function factsFromText(text, terms, limit = 2) {
  const out = []
  const seen = new Set()
  for (const sentence of splitSentences(text)) {
    const fact = usableFact(sentence, terms)
    if (!fact) continue
    const k = fact.replace(/\s+/g, '')
    if (seen.has(k)) continue
    seen.add(k)
    out.push(fact)
    if (out.length >= limit) break
  }
  return out
}

/** 摘要兜底：先按句读找；整段没有句号时按逗号切，再不行裁到 80 字——有出处就行。 */
function factsFromSnippet(snippet, terms) {
  const text = String(snippet ?? '').trim()
  if (!text) return []
  const direct = factsFromText(text, terms, 2)
  if (direct.length) return direct

  for (const part of cleanText(text).split(/[，,、]/)) {
    const fact = usableFact(part, terms)
    if (fact) return [fact]
  }
  const clipped = clip(text, MAX_FACT_CHARS)
  if ([...clipped].length >= MIN_FACT_CHARS && matchesTerms(clipped, terms)) return [clipped]
  return []
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

async function getText(fetchImpl, url, log) {
  try {
    const res = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    })
    if (!res || res.ok === false) {
      return { ok: false, status: Number(res?.status) || 0 }
    }
    const text = await res.text()
    return { ok: true, text: String(text ?? '') }
  } catch (e) {
    log?.(`取 ${url} 失败：${e?.message || e}`)
    return { ok: false, status: 0 }
  }
}

// ---------------------------------------------------------------------------
// 查一次 / 查一条
// ---------------------------------------------------------------------------

/**
 * 拿一个问题去查一次。纯网络函数：只依赖注入的 fetchImpl 和 store 的 studies 方法。
 * @returns {Promise<{ok:true,key:string,facts:string[],sources:Array<{title:string,url:string,from:'page'|'snippet'}>}|{ok:false,reason:string}>}
 */
export async function study({ store, question, fetchImpl = globalThis.fetch, now = Date.now(), maxPages = 2, log = () => {} } = {}) {
  const original = String(question ?? '')
  const q = original.trim()
  if (!q) return { ok: false, reason: '没有问题可查' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '没有可用的网络' }
  if (typeof store?.studiesPut !== 'function') return { ok: false, reason: '库不支持保存自学结果' }

  const key = studyKey(original)
  const { query, terms } = queryTerms(q)
  if (!query) return { ok: false, reason: '去完疑问词没有可搜的词' }

  const searchUrl = `${LEARN_ENDPOINT}${encodeURIComponent(query)}`
  log?.(`查：${q} → 搜「${query}」`)
  const searchPage = await getText(fetchImpl, searchUrl, log)
  if (!searchPage.ok || !searchPage.text.trim()) {
    return { ok: false, reason: '搜索页读不到' }
  }

  const results = parseSearchResults(searchPage.text)
  if (!results.length) return { ok: false, reason: '搜索没有结果' }

  const pages = Math.max(1, Math.floor(Number(maxPages)) || 2)
  const picked = results.slice(0, pages)
  const candidates = []

  for (const item of picked) {
    const page = await getText(fetchImpl, item.url, log)
    let facts = []
    if (page.ok) {
      const body = cleanText(page.text)
      facts = factsFromText(body, terms, 2)
      if (!facts.length) log?.(`页面没抽出素材，退回摘要：${item.url}`)
    } else {
      log?.(`页面读不到（${page.status || '网络错误'}），退回摘要：${item.url}`)
    }

    if (facts.length) {
      for (const fact of facts) candidates.push({ fact, source: { title: item.title, url: item.url, from: 'page' } })
      continue
    }
    for (const fact of factsFromSnippet(item.snippet, terms)) {
      candidates.push({ fact, source: { title: item.title, url: item.url, from: 'snippet' } })
    }
  }

  const facts = []
  const sources = []
  const seenFacts = new Set()
  const seenSources = new Set()
  for (const c of candidates) {
    const fk = c.fact.replace(/\s+/g, '')
    if (seenFacts.has(fk)) continue
    seenFacts.add(fk)
    facts.push(c.fact)
    if (!seenSources.has(c.source.url)) {
      seenSources.add(c.source.url)
      sources.push(c.source)
    }
    if (facts.length >= MAX_FACTS) break
  }

  if (!facts.length) return { ok: false, reason: '没抽到能用的素材' }

  try {
    store.studiesPut([{ key, question: q, facts, sources, at: Number(now) || Date.now() }])
  } catch (e) {
    return { ok: false, reason: `自学结果写不进库：${e?.message || e}` }
  }
  log?.(`查到 ${facts.length} 条（来源 ${sources.length} 个）`)
  return { ok: true, key, facts, sources }
}

/**
 * 挑还没查过的问题，逐条查。studies 里已有 key 的跳过；没得查返回空数组。
 * @returns {Promise<{ok:boolean, studied:Array<{key:string,question:string,facts:string[]}>, skipped?:number, reason?:string}>}
 */
export async function learn({ store, now = Date.now(), maxQuestions = 1, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (typeof store?.studiesAll !== 'function' || typeof store?.studiesPut !== 'function') {
    return { ok: false, reason: '库不支持自学' }
  }
  const limit = Math.max(0, Math.floor(Number(maxQuestions) || 0))
  if (!limit) return { ok: true, studied: [] }

  let done = new Set()
  try {
    done = new Set((store.studiesAll() || []).map((r) => String(r.key)))
  } catch {
    done = new Set()
  }

  const open = listQuestions(store, { status: 'open', limit: Math.max(50, limit) })
  const todo = []
  for (const q of open) {
    const text = String(q?.text ?? '').trim()
    if (!text) continue
    if (done.has(studyKey(q.text))) continue
    todo.push(q)
    if (todo.length >= limit) break
  }
  if (!todo.length) return { ok: true, studied: [] }

  const studied = []
  let skipped = 0
  for (const q of todo) {
    const r = await study({ store, question: String(q.text), fetchImpl, now, log })
    if (r.ok) studied.push({ key: r.key, question: String(q.text), facts: r.facts })
    else {
      skipped += 1
      log?.(`没查成：${q.text}（${r.reason}）`)
    }
  }

  const out = { ok: studied.length > 0, studied }
  if (skipped) out.skipped = skipped
  if (!out.ok) out.reason = '一条也没查成'
  return out
}
