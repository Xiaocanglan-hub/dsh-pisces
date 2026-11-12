// persona：提示词段与主人概览。段内容是给模型看的，所以"有没有多写"比"有没有少写"更要紧。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildSections, observe, COLD_START_LINES } from '../lib/persona.js'
import { createStore } from '../lib/store.js'
import { createMind } from '../lib/split.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')

async function mkStore(events = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-persona-'))
  const store = await createStore({ root, forceJsonl: true })
  for (const e of events) await store.append({ ts: NOW, source: 'system', ...e })
  return store
}

const sec = (r, name) => r.sections.find((s) => s.name === `pisces:${name}`)
const BUDGETED = ['pisces:self', 'pisces:mode', 'pisces:learned', 'pisces:observed']
const budgeted = (r) =>
  r.sections.filter((s) => BUDGETED.includes(s.name)).reduce((n, s) => n + s.text.split('\n').length, 0)

test('persona day：没有 seed 写"刚开始存在"，有 seed 按天数算', async () => {
  const a = await mkStore([])
  const r1 = buildSections({ store: a, now: NOW })
  assert.equal(sec(r1, 'day').text, '你刚开始存在')
  assert.equal(sec(r1, 'day').order, 8500)
  assert.equal(r1.coldStart, true)
  assert.deepEqual(r1.sections.map((s) => s.name), ['pisces:day'])
  a.close()

  const b = await mkStore([{ type: 'seed', text: '你不是助手。', ts: NOW - 3 * DAY }])
  const r2 = buildSections({ store: b, now: NOW })
  assert.equal(sec(r2, 'day').text, '你存在了 4 天')
  assert.equal(r2.coldStart, true)
  b.close()
})

test('persona self：最多两句旧话 + 称呼 + 一条疤，整段没有任何数字', async () => {
  const store = await mkStore([
    { type: 'seed', text: '你不是助手，别装。', ts: NOW - 20 * DAY },
    { type: 'utterance', text: '我喜欢把事情想清楚再动手。', ts: NOW - 19 * DAY },
    { type: 'utterance', text: '我不太相信口头保证。', ts: NOW - 18 * DAY },
    { type: 'utterance', text: '写代码这件事让我踏实。', ts: NOW - 17 * DAY },
    { type: 'meta', text: 'import-name:鲸歌', ts: NOW - 16 * DAY },
  ])
  const rf = await store.append({ type: 'refusal', text: '今天不想写。', ts: NOW - 15 * DAY, source: 'system' })
  await store.append({ type: 'meta', text: `react:${rf.id}:hurt`, refs: [rf.id], ts: NOW - 14 * DAY, source: 'system' })

  const r = buildSections({ store, now: NOW })
  const self = sec(r, 'self')
  assert.ok(self, 'self 段应该存在')
  assert.equal(self.order, 8510)
  const lines = self.text.split('\n')
  assert.equal(lines.filter((l) => l.startsWith('你以前说过：')).length, 2, '最多两句')
  assert.equal(lines.length, 4, '两句旧话 + 称呼 + 一条疤')
  assert.ok(self.text.includes('你管他叫鲸歌'))
  assert.ok(self.text.includes('有一件事你到现在没想清楚：今天不想写。'))
  assert.ok(!/[0-9０-９]/.test(self.text), `self 里不许有数字：${self.text}`)

  // 她自己的原话里带数字，也掐掉（数字不进提示词是硬口径，原文在事件流里）
  const q = await mkStore([
    { type: 'seed', text: '你不是助手。', ts: NOW - 10 * DAY },
    { type: 'utterance', text: '我今年 30 岁，做了 5 年这个。', ts: NOW - 9 * DAY },
  ])
  const rq = buildSections({ store: q, now: NOW })
  assert.ok(!/[0-9０-９]/.test(sec(rq, 'self').text), sec(rq, 'self').text)
  store.close()
  q.close()
})

test('persona mode：分流前没有，分流后只有一句口吻且不含数字', async () => {
  const store = await mkStore([{ type: 'seed', text: '你不是助手。', ts: NOW - 10 * DAY }])

  const before = createMind({ store })
  const r0 = buildSections({ store, mind: before, now: NOW })
  assert.equal(sec(r0, 'mode'), undefined, '分流前不该有 mode 段')

  const mind = createMind({ store })
  let seq = 0
  for (let i = 0; i < 8; i++) mind.fold({ seq: ++seq, label: 'd', by: 'rule' })
  for (let i = 0; i < 4; i++) mind.fold({ seq: ++seq, label: 'i', by: 'rule' })
  assert.ok(mind.describe().splitAt, '8:4 应该分流')
  assert.equal(mind.describe().promptLines.length, 1, '这个 band 只该有一句口吻')

  const r1 = buildSections({ store, mind, now: NOW })
  const mode = sec(r1, 'mode')
  assert.ok(mode, '分流后该有 mode 段')
  assert.equal(mode.order, 8520)
  assert.equal(mode.text.split('\n').length, 1, '最多一行')
  assert.ok(!/[0-9０-９]/.test(mode.text))
  store.close()
})

test('persona questions：最多三条 open，且不占冷启动三行预算', async () => {
  // 没有 seed → day 1，冷启动，最容易把预算吃满
  const store = await mkStore([{ type: 'utterance', text: '我不太相信口头保证。', ts: NOW - DAY }])
  const questions = [
    { id: 'q1', text: '他为什么总在半夜说话？', status: 'open' },
    { id: 'q2', text: '他说的"过几天"是几天？', status: 'open' },
    { id: 'q3', text: '他到底在不在躲我？', status: 'open' },
    { id: 'q4', text: '第四条不该出现。', status: 'open' },
    { id: 'q5', text: '已经答过的。', status: 'answered' },
  ]
  const r = buildSections({ store, questions, now: NOW })
  const q = sec(r, 'questions')
  assert.ok(q, '有 open 问题就该挂 questions')
  assert.equal(q.order, 9020)
  const items = q.text.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(items.length, 3, '最多三条')
  assert.ok(q.text.includes('他为什么总在半夜说话'))
  assert.ok(!q.text.includes('第四条不该出现'))
  assert.ok(!q.text.includes('已经答过的'))

  assert.equal(r.coldStart, true)
  assert.ok(budgeted(r) <= COLD_START_LINES, `冷启动预算被 questions 占了：${budgeted(r)}`)
  assert.ok(r.lines.length > COLD_START_LINES, 'questions 不占预算，总行数可以超过三行')
  store.close()
})

test('persona learned / observed：末尾标注"查来的"，observed 两行配对', async () => {
  const store = await mkStore([{ type: 'seed', text: '你不是助手。', ts: NOW - 10 * DAY }])
  const studies = [
    { question: '旧问题', facts: ['旧事实'], sources: ['x'] },
    {
      question: '猫为什么会踩奶？',
      facts: ['踩奶是一种幼态延续行为。', '常发生在放松的时候。', '第三条事实不该出现。'],
      sources: ['百度百科', '知乎'],
    },
  ]
  const observed = [
    { hypothesis: '旧的假设', evidence: '旧的证据' },
    { hypothesis: '他其实在躲我。', evidence: '他连续几天没有出现。' },
  ]

  const r = buildSections({ store, studies, observed, now: NOW })
  const learned = sec(r, 'learned')
  assert.ok(learned, '最近一条有事实就该挂 learned')
  assert.equal(learned.order, 9030)
  const ll = learned.text.split('\n')
  assert.equal(ll[ll.length - 1], '（这是查来的，不是你说过的。）')
  assert.ok(learned.text.includes('猫为什么会踩奶'), '只摆最近一条')
  assert.ok(!learned.text.includes('旧事实'))
  assert.ok(learned.text.includes('踩奶是一种幼态延续行为。'))
  assert.ok(learned.text.includes('常发生在放松的时候。'))
  assert.equal(ll.filter((l) => l.startsWith('- ')).length, 2, '最多两条事实')
  assert.ok(!learned.text.includes('第三条事实不该出现'))

  const obs = sec(r, 'observed')
  assert.ok(obs, '有配对的假设与证据就该挂 observed')
  assert.equal(obs.order, 9040)
  const ol = obs.text.split('\n')
  assert.equal(ol.length, 2)
  assert.ok(ol[0].startsWith('你想过一件事：'))
  assert.ok(ol[0].includes('他其实在躲我'))
  assert.ok(ol[1].startsWith('后来你确实遇见过：'))
  assert.ok(ol[1].includes('他连续几天没有出现'))
  store.close()
})

test('persona 冷启动：self/mode/learned/observed 合计不超过三行', async () => {
  const events = [
    { type: 'seed', text: '你不是助手。', ts: NOW - 2 * DAY },
    { type: 'utterance', text: '我喜欢慢慢来。', ts: NOW - 2 * DAY + 1000 },
    { type: 'utterance', text: '我不太相信保证。', ts: NOW - 2 * DAY + 2000 },
    { type: 'utterance', text: '写代码让我踏实。', ts: NOW - 2 * DAY + 3000 },
  ]
  const mind = { describe: () => ({ splitAt: 123, promptLines: ['你习惯先把事情算一遍再开口；算完了，话反而短。'] }) }
  const studies = [{ question: '猫为什么踩奶？', facts: ['a', 'b'], sources: [] }]
  const observed = [{ hypothesis: '他在躲我。', evidence: '他几天没来。' }]

  const store = await mkStore(events)
  const r = buildSections({ store, mind, studies, observed, now: NOW })
  assert.equal(r.coldStart, true)
  assert.equal(budgeted(r), COLD_START_LINES, '刚好吃满三行')
  assert.equal(sec(r, 'self').text.split('\n').length, 2)
  assert.equal(sec(r, 'mode').text.split('\n').length, 1)
  assert.equal(sec(r, 'learned'), undefined, '预算吃完就不挂')
  assert.equal(sec(r, 'observed'), undefined)
  assert.ok(sec(r, 'day'), 'day 不吃预算')
  store.close()

  // 第 8 天起不再冷启动：同样的输入，功能段都在
  const grown = await mkStore(events.map((e) => ({ ...e, ts: e.ts - 7 * DAY })))
  const r2 = buildSections({ store: grown, mind, studies, observed, now: NOW })
  assert.equal(r2.coldStart, false)
  assert.ok(sec(r2, 'self') && sec(r2, 'mode') && sec(r2, 'learned') && sec(r2, 'observed'))
  grown.close()
})

test('persona 空输入：只挂 day 段，不产生空段', () => {
  const r = buildSections({ now: NOW })
  assert.deepEqual(r.sections.map((s) => s.name), ['pisces:day'])
  assert.ok(r.sections.every((s) => s.text.trim().length > 0))
  assert.equal(r.lines.length, 1)
  assert.equal(r.coldStart, true)

  const r2 = buildSections({
    questions: [{ text: '', status: 'open' }],
    studies: [{ question: '', facts: [] }],
    observed: [{ hypothesis: '只有假设' }],
    now: NOW,
  })
  assert.deepEqual(r2.sections.map((s) => s.name), ['pisces:day'])
})

test('persona observe：只给主人看的概览，字段齐全且不抛', async () => {
  const store = await mkStore([
    { type: 'seed', text: '你不是助手。', ts: NOW - 3 * DAY },
    { type: 'utterance', text: '慢慢来。', ts: NOW - 2 * DAY },
  ])
  const r = observe({
    store,
    mind: { describe: () => ({ order: 'R>E', splitAt: 111 }) },
    questions: [
      { text: 'a', status: 'open' },
      { text: 'b', status: 'open' },
      { text: 'c', status: 'answered' },
    ],
    dreams: [{ id: 'd1' }, { id: 'd2' }],
    nightly: { lastRun: () => ({ at: 42 }) },
    now: NOW,
  })
  assert.deepEqual(r, { day: 4, events: 2, order: 'R>E', splitAt: 111, openQuestions: 2, dreams: 2, lastNightly: { at: 42 } })

  const bare = observe({ now: NOW })
  assert.deepEqual(bare, { day: 1, events: 0, order: 'E=R', splitAt: null, openQuestions: 0, dreams: 0, lastNightly: null })
  store.close()
})

test('persona stance：拒绝升格后只挂一条立场，不吃冷启动三行预算', async () => {
  const store = await mkStore([{ type: 'seed', text: '你不是助手。', ts: NOW - 2 * DAY }])
  const r1 = await store.append({ type: 'refusal', text: '这件事我不替你决定。', ts: NOW - 1 * DAY, source: 'system' })
  await store.append({ type: 'refusal', text: '这件事，我不替你决定。', ts: NOW, source: 'system' })
  await store.append({ type: 'meta', text: `react:${r1.id}:insist`, ts: NOW, source: 'system' })

  const r = buildSections({ store, now: NOW })
  const st = sec(r, 'stance')
  assert.ok(st, 'stance 段应该存在')
  assert.equal(st.order, 8515)
  assert.equal(st.text.split('\n').length, 1)
  assert.ok(st.text.startsWith('立场：'))
  assert.ok(budgeted(r) <= COLD_START_LINES, 'stance 不吃冷启动三行预算')
  store.close()
})
