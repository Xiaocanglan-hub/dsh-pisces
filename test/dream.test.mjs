// dream：八道闸、失败只留痕、节奏与"同一个问题只做一次"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { questionKey } from '../lib/questions.js'
import {
  checkDream,
  dream,
  DREAM_GATES,
  DREAM_MIN_SENTENCES,
  DREAM_MAX_SENTENCES,
} from '../lib/dream.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const Q1 = '他为什么不解释？'
const Q2 = '你那天为什么没有回头？'

const GOOD = {
  scene: '黄昏的楼道里，她看见他站在门口，手里提着一个旧纸袋。',
  counterfactual: '如果那天她提前五分钟出门，也许会在楼梯口遇见他。',
  simulation: [
    '她先停在楼梯转角，听见楼上门关上的声音。',
    '她没有立刻往上走，而是把纸袋换到另一只手里。',
    '她想起他上次说会在楼下等，却一直没出现。',
    '她数着台阶，走到第三层时看见门缝里透出光。',
    '她抬手想敲，又先把手放回口袋。',
    '她转身下楼，决定明天再问。',
  ],
  hypothesis: '他会不会其实一直在等她先开口？',
  test: '下次见面时，先问他那天为什么没有回头。',
}

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-dream-'))
  return createStore({ root, forceJsonl: true })
}

function addQuestion(store, text, since = NOW - DAY) {
  const key = questionKey(text)
  store.questionPut([
    {
      key,
      kind: 'about',
      text,
      refs: ['ev_question'],
      since,
      status: 'open',
      source: 'utterance',
      at: NOW,
    },
  ])
  return key
}

function fakeModel(reply) {
  let calls = 0
  return {
    name: 'fake-dream',
    get calls() {
      return calls
    },
    async ask() {
      calls += 1
      return typeof reply === 'function' ? reply() : reply
    },
  }
}

const replyOf = (d) => JSON.stringify(d)

test('没有模型 / 模型没给成形 JSON：不落 dream_sim，只落 dream:failed 的 meta', async () => {
  const store = await mkStore()
  addQuestion(store, Q1)

  const noModel = await dream({ store, now: NOW })
  assert.equal(noModel.ok, false)
  assert.equal(noModel.reason, '没有模型')
  assert.equal(store.readAll().filter((e) => e.type === 'dream_sim').length, 0, '没有模型不落 dream_sim')

  const failed = await dream({ store, model: fakeModel('我只看见一片海。'), now: NOW + 1000 })
  assert.equal(failed.ok, false)
  assert.equal(failed.reason, '模型没给成形的梦')
  assert.equal(store.readAll().filter((e) => e.type === 'dream_sim').length, 0, '解析失败不落 dream_sim')

  const metas = store.readAll().filter((e) => e.type === 'meta' && String(e.text).startsWith('dream:failed:'))
  assert.equal(metas.length, 2, '两次失败各留一条 meta')
  assert.match(metas[0].text, /^dream:failed:/)
  assert.equal(store.questionAll()[0].status, 'open', '失败不改问题状态')
  store.close()
})

test('闸 1：scene 抄问题 → 拒；留一条 meta.rejected 的 dream_sim，问题仍 open', async () => {
  const store = await mkStore()
  const key = addQuestion(store, Q1)
  const out = await dream({
    store,
    model: fakeModel(replyOf({ ...GOOD, scene: Q1 })),
    now: NOW,
  })

  assert.equal(out.ok, false)
  assert.match(out.reason, /^scene-not-question/)
  const dreams = store.readAll().filter((e) => e.type === 'dream_sim')
  assert.equal(dreams.length, 1, '被拒也要留痕')
  assert.match(dreams[0].text, /^（这次没做成梦：/)
  assert.equal(dreams[0].meta.status, 'rejected')
  assert.ok(dreams[0].meta.rejected.some((p) => p.startsWith('scene-not-question')))
  assert.equal(store.questionAll().find((q) => q.key === key).status, 'open', '被拒不算 dream 过')
  store.close()

  const pure = checkDream({ ...GOOD, scene: Q1 }, { thread: Q1 })
  assert.equal(pure.ok, false)
  assert.ok(pure.problems.some((p) => p.startsWith('scene-not-question')))
})

test('闸 2：counterfactual 不以"如果"开头 → 拒', () => {
  const c = checkDream(
    { ...GOOD, counterfactual: '她那天看见了他，却没有回头。' },
    { thread: Q1 },
  )
  assert.equal(c.ok, false)
  assert.ok(c.problems.some((p) => p.startsWith('counterfactual-if')))
})

test('闸 3：simulation 只有 4 句或 9 句 → 拒；5–8 句放行', () => {
  for (const n of [4, 9]) {
    const sim = Array.from({ length: n }, (_, i) => `她第${i + 1}次走到楼梯口，停下来听了一会儿。`)
    const c = checkDream({ ...GOOD, simulation: sim }, { thread: Q1 })
    assert.equal(c.ok, false, `${n} 句应被拒`)
    assert.ok(c.problems.some((p) => p.startsWith('sentences')))
  }
  assert.equal(DREAM_MIN_SENTENCES, 5)
  assert.equal(DREAM_MAX_SENTENCES, 8)
  assert.equal(checkDream(GOOD, { thread: Q1 }).ok, true)
})

test('闸 4：hypothesis 不可验（"他好烦"）→ 拒', () => {
  const c = checkDream({ ...GOOD, hypothesis: '他好烦' }, { thread: Q1 })
  assert.equal(c.ok, false)
  assert.ok(c.problems.some((p) => p.startsWith('hypothesis-testable')))
})

test('闸 5：test 不可观察（"会好的"）→ 拒', () => {
  const c = checkDream({ ...GOOD, test: '会好的' }, { thread: Q1 })
  assert.equal(c.ok, false)
  assert.ok(c.problems.some((p) => p.startsWith('test-actionable')))
})

test('闸 6：scene / simulation 带 1. 2. 编号 → 拒；空场景/空问题也被挡', () => {
  const sceneList = checkDream(
    { ...GOOD, scene: '1. 黄昏的楼道里，她看见他站在门口。' },
    { thread: Q1 },
  )
  assert.equal(sceneList.ok, false)
  assert.ok(sceneList.problems.some((p) => p.startsWith('no-numbered-list')))

  const simList = checkDream(
    { ...GOOD, simulation: ['1. 她停在门口。', '2. 她听见楼上关门。', '3. 她没有上去。', '4. 她转身。', '5. 她下楼。'] },
    { thread: Q1 },
  )
  assert.equal(simList.ok, false)
  assert.ok(simList.problems.some((p) => p.startsWith('no-numbered-list')))

  const empty = checkDream({ ...GOOD, scene: '短', hypothesis: '', test: '' }, { thread: Q1 })
  assert.equal(empty.ok, false)
  assert.ok(empty.problems.some((p) => p.startsWith('not-empty')))

  const noKey = checkDream(GOOD, {})
  assert.equal(noKey.ok, false)
  assert.ok(noKey.problems.some((p) => p.startsWith('thread-key')))

  assert.deepEqual(DREAM_GATES, [
    'scene-not-question',
    'counterfactual-if',
    'sentences',
    'hypothesis-testable',
    'test-actionable',
    'no-numbered-list',
    'not-empty',
    'thread-key',
  ])
})

test('全过 → 落 dream_sim（type/meta/refs/status 对），问题变 observed 而不是 answered', async () => {
  const store = await mkStore()
  const key = addQuestion(store, Q1)
  const model = fakeModel(replyOf(GOOD))
  const out = await dream({ store, model, now: NOW })

  assert.equal(out.ok, true)
  assert.equal(model.calls, 1)
  assert.equal(out.event.type, 'dream_sim')
  assert.deepEqual(out.event.refs, ['ev_question'])
  assert.deepEqual(out.event.meta, {
    thread: Q1,
    threadKey: key,
    ...GOOD,
    status: 'untested',
  })
  assert.equal(out.event.meta.threadKey, questionKey(Q1))
  assert.equal(out.event.meta.status, 'untested')
  assert.match(out.event.text, /黄昏的楼道里/)
  assert.match(out.event.text, /她先停在楼梯转角/)
  assert.equal(out.dream.hypothesis, GOOD.hypothesis)
  assert.equal(out.event.status, undefined, 'status 只在 meta 里')

  const q = store.questionAll().find((x) => x.key === key)
  assert.equal(q.status, 'observed')
  assert.notEqual(q.status, 'answered')
  store.close()
})

test('节奏：3 天内第二次 → skipped；force:true 可以跑', async () => {
  const store = await mkStore()
  addQuestion(store, Q1, NOW - 2 * DAY)
  addQuestion(store, Q2, NOW - DAY)

  const first = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW })
  assert.equal(first.ok, true)

  const skipped = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW + DAY })
  assert.deepEqual({ ok: skipped.ok, reason: skipped.reason, skipped: skipped.skipped }, {
    ok: false,
    reason: '还没到做梦的日子',
    skipped: true,
  })

  const forced = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW + DAY, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.dream.threadKey, questionKey(Q2), 'force 跳到下一条没做过的')
  store.close()
})

test('同一个问题不重复：threadKey 相同换下一条；全做过 → 没有没做过的梦', async () => {
  const store = await mkStore()
  const k1 = addQuestion(store, Q1, NOW - 2 * DAY)
  const k2 = addQuestion(store, Q2, NOW - DAY)

  const first = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW })
  assert.equal(first.ok, true)
  assert.equal(first.dream.threadKey, k1)

  // 把第一条改回 open，模拟"问题还在，但这个梦已经做过了"。
  store.questionSetStatus(k1, 'open')
  const second = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW + 4 * DAY })
  assert.equal(second.ok, true)
  assert.equal(second.dream.threadKey, k2, '同 threadKey 不重做，换下一条')

  // 两条都做过且都还是 open → 没有没做过的梦。
  store.questionSetStatus(k1, 'open')
  store.questionSetStatus(k2, 'open')
  const none = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW + 8 * DAY })
  assert.equal(none.ok, false)
  assert.equal(none.reason, '没有没做过的梦')

  // 一条 open 都没有 → 没有问题可做。
  store.questionSetStatus(k1, 'answered')
  store.questionSetStatus(k2, 'answered')
  const empty = await dream({ store, model: fakeModel(replyOf(GOOD)), now: NOW + 9 * DAY })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, '没有问题可做')
  store.close()
})
