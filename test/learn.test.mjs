// learn：自学。去疑问词、只走 Bing、逐页抽 2–3 句、读不到退回摘要、studies 同 key 覆盖。
// 全部注入假 fetch：一条也不许真的连网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { LEARN_ENDPOINT, stripQuestion, studyKey, study, learn } from '../lib/learn.js'

const NOW = Date.parse('2026-11-09T12:00:00+08:00')

async function mkStore(questions = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-learn-'))
  const store = await createStore({ root, forceJsonl: true })
  if (questions.length) store.questionPut(questions)
  return store
}

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return String(body) } }
}

function searchHtml(items) {
  return `<!doctype html><html><body><ol>${items
    .map((it) => `<li class="b_algo"><h2><a href="${it.url}">${it.title}</a></h2><p class="b_lineclamp2">${it.snippet || ''}</p></li>`)
    .join('')}</ol></body></html>`
}

const page = (text) =>
  `<!doctype html><html><head><script>bad()</script><style>.x{color:red}</style></head><body><p>${text}</p></body></html>`

function scriptedFetch({ items, pages = {} }) {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    if (String(url).startsWith(LEARN_ENDPOINT)) return res(searchHtml(items))
    const hit = pages[url]
    if (typeof hit === 'function') return hit()
    if (hit === undefined) return res('', 404)
    return res(hit)
  }
  fetchImpl.seen = seen
  return fetchImpl
}

test('stripQuestion：去疑问/语气成分、留实词；全被去光就退回原句', () => {
  const s = stripQuestion('猫为什么会踩奶')
  assert.equal(s, '猫踩奶')
  assert.ok(!s.includes('为什么'))
  assert.ok(s.includes('猫'))
  assert.ok(s.includes('踩奶'))

  assert.equal(stripQuestion('猫会不会踩奶'), '猫踩奶')
  assert.equal(stripQuestion('会议什么时候开'), '会议开', '实词里的"会"不能被切掉')
  assert.equal(stripQuestion(''), '')
  assert.equal(stripQuestion('为什么？'), '为什么？')
  assert.equal(stripQuestion('吗呢啊'), '吗呢啊')
})

test('studyKey：16 位十六进制；对去疑问词后的句子取 hash，两种问法同 key', () => {
  const k = studyKey('猫为什么会踩奶')
  assert.match(k, /^[0-9a-f]{16}$/)
  assert.equal(k, 'cd3e4dc3cee7e0c8')
  assert.equal(k, studyKey('猫踩奶'), '同一件事的两种问法同 key')
  assert.equal(k, studyKey('猫为什么会踩奶？'))
  assert.equal(k, studyKey('猫踩奶？'))
  assert.notEqual(k, studyKey('天为什么总是灰的？'))
})

test('搜索只用去疑问词后的词，走 Bing', async () => {
  const store = await mkStore()
  const url = 'https://example.com/a'
  const fetchImpl = scriptedFetch({
    items: [{ title: '猫踩奶是什么', url, snippet: '猫踩奶是幼猫吃奶时用前爪按压母猫乳房的本能行为。' }],
    pages: { [url]: page('猫踩奶是一种幼态延续行为，多见于家猫。') },
  })
  const r = await study({ store, question: '猫为什么会踩奶', fetchImpl, now: NOW, maxPages: 1 })
  assert.equal(r.ok, true)
  assert.equal(fetchImpl.seen[0], `${LEARN_ENDPOINT}${encodeURIComponent('猫踩奶')}`)
  assert.ok(fetchImpl.seen[0].includes(encodeURIComponent('猫踩奶')))
  assert.ok(!decodeURIComponent(fetchImpl.seen[0]).includes('为什么'))
  store.close()
})

test('正常：两页各抽到句子 → facts 2–3 条、来源带 url、落 studies 一行且 facts 列是 JSON 字符串', async () => {
  const store = await mkStore()
  const a = 'https://example.com/a'
  const b = 'https://example.com/b'
  const fetchImpl = scriptedFetch({
    items: [
      { title: '猫踩奶是什么', url: a, snippet: '' },
      { title: '猫踩奶正常吗', url: b, snippet: '' },
    ],
    pages: {
      [a]: page('猫踩奶是一种幼态延续行为，多见于家猫。踩奶时猫的爪子会一张一合。'),
      [b]: page('小猫在幼年时期靠踩奶让母猫分泌更多乳汁。成年猫踩奶通常表示它感到安全。'),
    },
  })

  const r = await study({ store, question: '猫为什么会踩奶', fetchImpl, now: NOW, maxPages: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.key, studyKey('猫为什么会踩奶'))
  assert.ok(r.facts.length >= 2 && r.facts.length <= 3, `facts 应是 2–3 条，实际 ${r.facts.length}`)
  for (const f of r.facts) {
    const n = [...f].length
    assert.ok(n >= 10 && n <= 80, `事实长度应在 10–80：${n}`)
    assert.ok(f.includes('踩奶'), `事实应包含查询实词：${f}`)
  }
  assert.ok(r.sources.length >= 1)
  for (const s of r.sources) {
    assert.ok(s.url.startsWith('http'))
    assert.ok(s.title)
    assert.equal(s.from, 'page')
  }

  const rows = store.studiesAll()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, r.key)
  assert.equal(rows[0].question, '猫为什么会踩奶')
  assert.deepEqual(rows[0].facts, r.facts)
  assert.deepEqual(rows[0].sources, r.sources)
  assert.equal(rows[0].at, NOW)

  // 表里存的是 JSON 字符串，读出来才是数组。
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(store.root, 'index.db'), { readOnly: true })
  const raw = db.prepare('SELECT facts, sources FROM studies WHERE key = ?').get(r.key)
  db.close()
  assert.equal(typeof raw.facts, 'string')
  assert.equal(typeof raw.sources, 'string')
  assert.deepEqual(JSON.parse(raw.facts), r.facts)
  assert.deepEqual(JSON.parse(raw.sources), r.sources)
  store.close()
})

test('页面 403：退回搜索摘要，来源标 snippet，facts 仍然 ≥1', async () => {
  const store = await mkStore()
  const url = 'https://baike.baidu.com/item/踩奶'
  const fetchImpl = scriptedFetch({
    items: [{ title: '踩奶_百度百科', url, snippet: '猫踩奶是幼猫吃奶时用前爪按压母猫乳房的本能行为。' }],
    pages: { [url]: () => res('<html><body>403 Forbidden</body></html>', 403) },
  })

  const r = await study({ store, question: '猫为什么会踩奶', fetchImpl, now: NOW })
  assert.equal(r.ok, true)
  assert.ok(r.facts.length >= 1)
  assert.equal(r.sources[0].from, 'snippet')
  assert.equal(r.sources[0].url, url)
  assert.equal(store.studiesAll().length, 1)
  store.close()
})

test('一条事实都抽不到 → ok:false，且不落库', async () => {
  const store = await mkStore()
  const url = 'https://example.com/x'
  const fetchImpl = scriptedFetch({
    items: [{ title: '今日天气', url, snippet: '今天天气不错，适合出门散步。' }],
    pages: { [url]: page('今天是晴天，风也不大。') },
  })

  const r = await study({ store, question: '猫为什么会踩奶', fetchImpl, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '没抽到能用的素材')
  assert.equal(store.studiesAll().length, 0)
  store.close()
})

test('learn：只查没查过的，最多 maxQuestions 条；都查过返回空 studied', async () => {
  const q1 = '猫为什么会踩奶？'
  const q2 = '天为什么总是灰的？'
  const q3 = '你昨天说的那句还算数吗？'
  const store = await mkStore([
    { key: 'k1', kind: 'about', text: q1, refs: [], since: NOW - 3000, status: 'open', source: 'utterance', at: NOW },
    { key: 'k2', kind: 'about', text: q2, refs: [], since: NOW - 2000, status: 'open', source: 'utterance', at: NOW },
    { key: 'k3', kind: 'to-you', text: q3, refs: [], since: NOW - 1000, status: 'open', source: 'utterance', at: NOW },
  ])
  // q1 已经查过：learn 必须跳过它。
  store.studiesPut([{ key: studyKey(q1), question: q1, facts: ['旧事实'], sources: [], at: NOW - 10_000 }])

  const sentences = new Map([
    ['天总是灰的', '天总是灰的是因为空气里有很多细小的颗粒。'],
    ['你昨天说的那句还算数', '你昨天说的那句还算数这件事我一直记着。'],
  ])
  const fetchImpl = async (url) => {
    if (String(url).startsWith(LEARN_ENDPOINT)) {
      const q = new URL(url).searchParams.get('q')
      const pageUrl = `https://example.com/${encodeURIComponent(q)}`
      return res(searchHtml([{ title: `关于${q}`, url: pageUrl, snippet: `${q}是一种常见现象。` }]))
    }
    const q = decodeURIComponent(String(url).split('/').pop())
    return res(page(sentences.get(q) || ''))
  }

  const first = await learn({ store, now: NOW, maxQuestions: 1, fetchImpl })
  assert.equal(first.ok, true)
  assert.equal(first.studied.length, 1, 'maxQuestions=1 只查一条')
  assert.equal(first.studied[0].question, q2, 'q1 查过就跳过，先查 q2')
  assert.equal(first.studied[0].key, studyKey(q2))
  assert.equal(first.skipped, undefined)
  assert.equal(store.studiesAll().length, 2)
  // q1 的旧素材没被覆盖
  assert.deepEqual(store.studiesAll().find((r) => r.key === studyKey(q1)).facts, ['旧事实'])

  const second = await learn({ store, now: NOW, maxQuestions: 5, fetchImpl })
  assert.equal(second.ok, true)
  assert.deepEqual(second.studied.map((s) => s.question), [q3], '只剩 q3 没查')
  assert.equal(store.studiesAll().length, 3)

  assert.deepEqual(await learn({ store, now: NOW, maxQuestions: 5, fetchImpl }), { ok: true, studied: [] })
  store.close()
})

test('同一问题再查一次：覆盖同一 key，不新增行，at/facts/sources 都是新的', async () => {
  const store = await mkStore()
  const q = '猫为什么会踩奶'
  const oldUrl = 'https://example.com/old'
  const newUrl = 'https://example.com/new'
  const f1 = scriptedFetch({
    items: [{ title: '旧来源', url: oldUrl, snippet: '' }],
    pages: { [oldUrl]: page('猫踩奶是一种幼态延续行为，多见于家猫。') },
  })
  const f2 = scriptedFetch({
    items: [{ title: '新来源', url: newUrl, snippet: '' }],
    pages: { [newUrl]: page('成年猫踩奶通常表示它感到安全和放松。') },
  })

  const r1 = await study({ store, question: q, fetchImpl: f1, now: NOW })
  const r2 = await study({ store, question: q, fetchImpl: f2, now: NOW + 5000 })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r1.key, r2.key)

  const rows = store.studiesAll()
  assert.equal(rows.length, 1, '同一个 key 只留一行')
  assert.equal(rows[0].question, q, 'question 保留原句')
  assert.equal(rows[0].at, NOW + 5000)
  assert.deepEqual(rows[0].facts, r2.facts)
  assert.ok(rows[0].facts[0].includes('成年猫'))
  assert.equal(rows[0].sources[0].url, newUrl)
  store.close()
})

test('同一件事的两种问法：同 key，后查的覆盖原行而不是新增', async () => {
  const store = await mkStore()
  const a = 'https://example.com/a'
  const b = 'https://example.com/b'
  const f1 = scriptedFetch({
    items: [{ title: '问法一', url: a, snippet: '' }],
    pages: { [a]: page('猫踩奶是一种幼态延续行为，多见于家猫。') },
  })
  const f2 = scriptedFetch({
    items: [{ title: '问法二', url: b, snippet: '' }],
    pages: { [b]: page('成年猫踩奶通常表示它感到安全和放松。') },
  })

  const r1 = await study({ store, question: '猫为什么会踩奶', fetchImpl: f1, now: NOW })
  const r2 = await study({ store, question: '猫踩奶', fetchImpl: f2, now: NOW + 1000 })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(r1.key, r2.key)
  assert.equal(r1.key, 'cd3e4dc3cee7e0c8')

  const rows = store.studiesAll()
  assert.equal(rows.length, 1, '两种问法只留一行')
  assert.equal(rows[0].key, 'cd3e4dc3cee7e0c8')
  assert.equal(rows[0].question, '猫踩奶', 'question 保留最近一次的原句')
  assert.deepEqual(rows[0].facts, r2.facts)
  assert.equal(rows[0].sources[0].url, b)
  store.close()
})
