// questions：自疑问。三类来源、Dice 合并、状态只进不退、list 默认只看 open。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import {
  QUESTION_STATUS,
  questionKey,
  dice,
  extractQuestions,
  syncQuestions,
  listQuestions,
  setQuestionStatus,
} from '../lib/questions.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')

async function mkStore(events = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-questions-'))
  const store = await createStore({ root, forceJsonl: true })
  for (const e of events) await store.append({ ts: NOW, source: 'system', ...e })
  return store
}

test('questionKey：去空白/标点后同一句同 key，不同句不同 key', () => {
  const a = questionKey('他为什么不解释？')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(a, questionKey(' 他为什么不解释 '))
  assert.equal(a, questionKey('他为什么不解释'))
  assert.equal(a, questionKey('他为什么不解释!'))
  assert.notEqual(a, questionKey('他为什么不肯解释？'))
  // 与老库真实样本一致：旧 key 就是 16 位，破折号算正文、问号不算。
  assert.equal(questionKey('先说这些，够不够用来试你说的那个？'), 'b67c8458fc85e749')
  assert.equal(questionKey('看着跟聊天窗口里挂的那个角色是同一个——是不是你给我这边的头像？'), '9ab54c3836c27dba')
})

test('dice：同义问句 >= 0.8，不同问句差得远，同一句为 1', () => {
  const same = dice('他为什么不解释？', '他为什么不肯解释？')
  assert.ok(same >= 0.8, `同义问句应 >= 0.8，实际 ${same}`)
  assert.equal(dice('他为什么不解释？', '他为什么不解释'), 1)
  assert.ok(dice('他为什么不解释？', '今天中午吃什么？') < 0.3)
  assert.ok(dice('', '有字') === 0)
})

test('extractQuestions：三类来源 about / to-you / uncertain', async () => {
  const store = await mkStore([
    { type: 'utterance', text: '为什么天总是灰的？', ts: NOW - 3 * DAY },
    { type: 'utterance', text: '你到底有没有在听我说话？', ts: NOW - 2 * DAY },
    { type: 'utterance', text: '猫为什么总在半夜踩奶这件事我一直没想明白', ts: NOW - DAY },
  ])
  const all = store.readAll()
  const third = all.find((e) => String(e.text).includes('踩奶'))
  await store.attribPut([
    { seq: third.seq, day: third.day, label: 'null', conf: 0.3, why: '拿不准（长22）', by: 'rule', model: '', at: NOW },
  ])

  const qs = extractQuestions(all, store.attribAll())
  assert.equal(qs.length, 3)
  const byKind = Object.fromEntries(qs.map((q) => [q.kind, q]))
  assert.ok(byKind.about, '带问号没人答 → about')
  assert.equal(byKind.about.source, 'utterance')
  assert.equal(byKind.about.key, questionKey(byKind.about.text))
  assert.ok(byKind['to-you'], '问句里出现"你" → to-you')
  assert.equal(byKind['to-you'].text, '你到底有没有在听我说话？')
  assert.ok(byKind.uncertain, '归因 null 且低置信 → uncertain')
  assert.equal(byKind.uncertain.source, 'attrib')
  assert.deepEqual(byKind.uncertain.refs, [third.id])
  assert.equal(byKind.uncertain.since, NOW - DAY)
  store.close()
})

test('extractQuestions：没问号、纯感叹、meta/heard 不进候选；被 answer 指向的不算悬着', async () => {
  const store = await mkStore([
    { type: 'utterance', text: '今天风很大。', ts: NOW - 4 * DAY },
    { type: 'utterance', text: '啊啊啊？？？', ts: NOW - 4 * DAY + 1000 },
    { type: 'meta', text: '他为什么不来？', ts: NOW - 4 * DAY + 2000 },
    { type: 'heard', text: '你吃了吗？', ts: NOW - 4 * DAY + 3000 },
    { type: 'utterance', text: '那他到底来不来？', ts: NOW - 3 * DAY },
  ])
  const qev = store.readAll().find((e) => String(e.text).includes('来不来'))
  await store.append({ type: 'answer', text: '来。', refs: [qev.id], ts: NOW - 3 * DAY + 1000, source: 'owner' })

  assert.deepEqual(extractQuestions(store.readAll()), [])
  store.close()
})

test('extractQuestions：两句近义合并成一条，refs 累加，key 用第一句，since 取最早', async () => {
  const store = await mkStore([
    { type: 'utterance', text: '他为什么不肯解释？', ts: NOW - 2 * DAY },
    { type: 'utterance', text: '他为什么不解释？', ts: NOW - DAY },
  ])
  const qs = extractQuestions(store.readAll())
  assert.equal(qs.length, 1, '近义句应合并成一条')
  assert.equal(qs[0].key, questionKey('他为什么不肯解释？'), 'key 用第一句算，合并后不变')
  assert.equal(qs[0].text, '他为什么不肯解释？')
  assert.deepEqual(qs[0].refs.map(String).sort(), store.readAll().map((e) => e.id).sort(), 'refs 两条都在')
  assert.equal(qs[0].since, NOW - 2 * DAY, 'since 取最早那条')
  assert.equal(qs[0].kind, 'to-you')
  store.close()
})

test('syncQuestions：第二次 added=0，answered 不被扫回 open，只补新的', async () => {
  const store = await mkStore([
    { type: 'utterance', text: '为什么天总是灰的？', ts: NOW - 2 * DAY },
    { type: 'utterance', text: '他为什么不肯解释？', ts: NOW - DAY },
  ])
  assert.deepEqual(syncQuestions(store, { now: NOW }), { added: 2, merged: 0, kept: 0, total: 2 })

  const open = listQuestions(store)
  assert.equal(open.length, 2)
  const target = open.find((q) => q.text.includes('天总是灰的'))
  assert.deepEqual(setQuestionStatus(store, target.key, 'answered'), { ok: true })

  assert.deepEqual(syncQuestions(store, { now: NOW + 1000 }), { added: 0, merged: 0, kept: 2, total: 2 })
  assert.equal(store.questionAll().find((q) => q.key === target.key).status, 'answered', '状态不许被覆盖')
  assert.equal(listQuestions(store).length, 1, '默认只看 open')

  // 新问题进来：只补新的，answered 那条仍不动
  await store.append({ type: 'utterance', text: '你昨天说的那句话还算数吗？', ts: NOW + 2000 })
  assert.deepEqual(syncQuestions(store, { now: NOW + 3000 }), { added: 1, merged: 0, kept: 2, total: 3 })
  assert.equal(store.questionAll().find((q) => q.key === target.key).status, 'answered')
  store.close()
})

test('setQuestionStatus：只认四个状态，非法状态/不存在的 key 都拒绝', async () => {
  const store = await mkStore([{ type: 'utterance', text: '为什么天总是灰的？', ts: NOW }])
  syncQuestions(store, { now: NOW })
  const key = listQuestions(store)[0].key

  const bad = setQuestionStatus(store, key, 'closed')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /open/)
  assert.equal(store.questionAll()[0].status, 'open', '非法状态不改库')

  assert.deepEqual(setQuestionStatus(store, 'ffffffffffffffff', 'answered'), { ok: false, reason: '没有这条问题' })

  for (const s of QUESTION_STATUS) {
    assert.deepEqual(setQuestionStatus(store, key, s), { ok: true })
    assert.equal(store.questionAll()[0].status, s)
  }
  store.close()
})

test('listQuestions：默认只出 open，limit 生效，refs 解成数组；questionPut 不覆盖状态', async () => {
  const store = await mkStore([])
  const k1 = questionKey('旧问题？')
  const k2 = questionKey('中间的问题？')
  const k3 = questionKey('新问题？')
  const k4 = questionKey('已经答过的问题？')
  store.questionPut([
    { key: k1, kind: 'about', text: '旧问题？', refs: ['e1'], since: NOW - 3 * DAY, status: 'open', source: 'utterance', at: NOW },
    { key: k2, kind: 'to-you', text: '中间的问题？', refs: ['e2'], since: NOW - 2 * DAY, status: 'open', source: 'utterance', at: NOW },
    { key: k3, kind: 'about', text: '新问题？', refs: ['e3'], since: NOW - DAY, status: 'open', source: 'utterance', at: NOW },
    { key: k4, kind: 'uncertain', text: '已经答过的问题？', refs: ['e4'], since: NOW, status: 'answered', source: 'attrib', at: NOW },
  ])

  const open = listQuestions(store)
  assert.equal(open.length, 3)
  assert.deepEqual(open.map((q) => q.key), [k1, k2, k3], '按 since 从旧到新')
  assert.deepEqual(open[0].refs, ['e1'], 'refs 是数组，不是 JSON 字符串')

  const two = listQuestions(store, { limit: 2 })
  assert.equal(two.length, 2)
  assert.deepEqual(two.map((q) => q.key), [k1, k2])

  assert.equal(listQuestions(store, { status: 'answered' }).length, 1)
  assert.equal(listQuestions(store, { status: 'all' }).length, 4)

  // 直接 upsert 也不许把 answered 改回 open，只补 refs
  store.questionPut([{ key: k4, kind: 'uncertain', text: '已经答过的问题？', refs: ['e5'], since: NOW - 10 * DAY, status: 'open', source: 'attrib', at: NOW }])
  const kept = store.questionAll().find((q) => q.key === k4)
  assert.equal(kept.status, 'answered')
  assert.deepEqual(kept.refs.sort(), ['e4', 'e5'])
  store.close()
})
