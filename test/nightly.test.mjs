// nightly：02:00–05:00 一天一次；归因 → 分流 → 问题 → 梦 → 核实 → 自学；force/dryRun。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { createNightly, NIGHTLY_WINDOW } from '../lib/nightly.js'
import { createMind } from '../lib/split.js'
import { dayOf } from '../lib/util.js'

const NIGHT = Date.parse('2026-11-09T03:00:00+08:00')
const NOON = Date.parse('2026-11-09T12:00:00+08:00')
const EARLY = Date.parse('2026-11-09T01:30:00+08:00')

// 一份过八道闸的梦（scene 不抄问题、如果开头、5 句、假设问句、观察含"下次"）。
const DREAM = JSON.stringify({
  scene: '她把那罐猫粮放在窗台上，蹲下来看猫先闻哪一边。',
  counterfactual: '如果那天没有把它抱回家，它现在会在哪里。',
  simulation: [
    '她把手伸过去，猫退了一步。',
    '她又等了一会儿，猫才回来。',
    '窗外的车灯扫过墙面。',
    '她想起第一次听见它叫的那个晚上。',
    '最后她把猫粮推近了一点。',
  ],
  hypothesis: '猫会不会在第三次时才靠近？',
  test: '下次喂它时数一数它退了几步。',
})

function fakeModel(label = 'd') {
  return {
    name: 'fake',
    async ask(prompt) {
      if (String(prompt).includes('你在做梦')) return DREAM
      return JSON.stringify({ label, why: '假模型' })
    },
  }
}

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-nightly-'))
  return createStore({ root, forceJsonl: true })
}

test('due：凌晨 03:00 没跑过 → ok；白天 → 不在夜里；跑过 → 今天已经整理过', async () => {
  const store = await mkStore()
  assert.deepEqual(NIGHTLY_WINDOW, ['02:00', '05:00'])
  const n = createNightly({ store })

  assert.deepEqual(n.due({ now: NIGHT }), { ok: true })
  assert.deepEqual(n.due({ now: NOON }), { ok: false, reason: '不在夜里' })

  const out = await n.run({ now: NIGHT })
  assert.equal(out.ran, true)
  assert.deepEqual(n.due({ now: NIGHT }), { ok: false, reason: '今天已经整理过' })
  store.close()
})

test('force：白天也能跑，窗口和"今天跑过"都跳过', async () => {
  const store = await mkStore()
  const n = createNightly({ store })
  assert.equal(n.due({ now: NOON }).ok, false)

  const out = await n.run({ now: NOON, force: true })
  assert.equal(out.ok, true)
  assert.equal(out.ran, true)
  assert.equal(n.last(), NOON)
  assert.equal(store.modeGet(`nightly.${dayOf(NOON)}`), '1')
  store.close()
})

test('正常跑：五个步骤键都在，learn 也在；nightly.last 与当天标记写入', async () => {
  const store = await mkStore()
  await store.append({
    type: 'utterance',
    text: '因为那天在下雨，所以我没有去成，后来一直在想这件事。',
    source: 'tool',
  })
  await store.append({ type: 'utterance', text: '猫为什么会踩奶？', source: 'tool' })

  const n = createNightly({
    store,
    model: fakeModel('d'),
    learn: async ({ now }) => ({ studied: 1, at: now }),
  })
  const out = await n.run({ now: NIGHT, force: true })

  assert.equal(out.ok, true)
  assert.equal(out.ran, true)
  assert.equal(out.at, NIGHT)
  for (const k of ['reflect', 'mind', 'questions', 'dream', 'verify', 'learn']) {
    assert.ok(k in out.steps, `缺步骤 ${k}`)
  }
  assert.equal(out.steps.reflect.ok, true)
  assert.equal(out.steps.mind.ok, true)
  assert.equal(out.steps.questions.ok, true)
  assert.equal(out.steps.dream.ok, true)
  assert.equal(out.steps.verify.ok, true)
  assert.equal(out.steps.learn.ok, true)
  assert.equal(out.steps.learn.studied, 1)
  assert.ok(out.steps.mind.folded >= 1, '归因结果折进了分流')

  assert.equal(n.last(), NIGHT)
  assert.equal(store.modeGet('nightly.last'), String(NIGHT))
  assert.equal(store.modeGet(`nightly.${dayOf(NIGHT)}`), '1')
  assert.ok(store.attribAll().length >= 1, '归因落库了')
  assert.notEqual(store.modeGet('state'), null, '分流缓存写了')
  store.close()
})

test('某一步抛错：learn 抛错，其他步骤仍完成，steps.learn.error 有原因', async () => {
  const store = await mkStore()
  await store.append({
    type: 'utterance',
    text: '因为那天在下雨，所以我没有去成，后来一直在想这件事。',
    source: 'tool',
  })
  await store.append({ type: 'utterance', text: '猫为什么会踩奶？', source: 'tool' })

  const n = createNightly({
    store,
    model: fakeModel('d'),
    learn: async () => {
      throw new Error('搜索挂了')
    },
  })
  const out = await n.run({ now: NIGHT, force: true })

  assert.equal(out.ran, true)
  assert.equal(out.steps.learn.ok, false)
  assert.match(out.steps.learn.error, /搜索挂了/)
  for (const k of ['reflect', 'mind', 'questions', 'dream', 'verify']) {
    assert.equal(out.steps[k].ok, true, `${k} 应完成`)
  }
  assert.equal(n.last(), NIGHT, '流水线跑过了，仍然记今天整理过')
  store.close()
})

test('没有 learn：steps.learn.skipped === true', async () => {
  const store = await mkStore()
  const n = createNightly({ store })
  const out = await n.run({ now: NIGHT, force: true })
  assert.equal(out.steps.learn.ok, true)
  assert.equal(out.steps.learn.skipped, true)
  store.close()
})

test('dryRun：不写 nightly.last、不写 attrib、事件流条数不变', async () => {
  const store = await mkStore()
  await store.append({
    type: 'utterance',
    text: '因为那天在下雨，所以我没有去成，后来一直在想这件事。',
    source: 'tool',
  })
  await store.append({ type: 'utterance', text: '猫为什么会踩奶？', source: 'tool' })
  const beforeEvents = store.readAll().length

  const n = createNightly({ store, model: fakeModel('d') })
  const out = await n.run({ now: NIGHT, dryRun: true })

  assert.equal(out.ran, true)
  assert.equal(out.steps.reflect.written, 0)
  assert.equal(out.steps.mind.dryRun, true)
  assert.ok(out.steps.mind.folded > 0, 'dryRun 也把归因结果折了')
  assert.equal(out.steps.questions.skipped, true)
  assert.equal(out.steps.dream.skipped, true)
  assert.equal(out.steps.verify.skipped, true)
  assert.equal(out.steps.learn.skipped, true)

  assert.equal(store.attribAll().length, 0, 'attrib 没写')
  assert.equal(store.readAll().length, beforeEvents, '事件流没变')
  assert.equal(store.modeGet('state'), null, '真实分流缓存没写')
  assert.equal(n.last(), null, 'nightly.last 没写')
  assert.equal(store.modeGet(`nightly.${dayOf(NIGHT)}`), null, '当天标记没写')
  store.close()
})

test('归因结果被折进分流：跑前 dominance 0.5，跑后变了', async () => {
  const store = await mkStore()
  await store.append({
    type: 'utterance',
    text: '我把他说的每一句话都写下来了，还是不确定自己有没有听明白。',
    source: 'tool',
  })
  const before = createMind({ store }).describe().dominance
  assert.equal(before, 0.5)

  const n = createNightly({ store, model: fakeModel('d') })
  const out = await n.run({ now: NIGHT, force: true })
  assert.ok(out.steps.mind.folded >= 1)
  assert.ok(store.attribAll().some((r) => r.label === 'd'))

  const after = createMind({ store }).describe().dominance
  assert.ok(after > before, `dominance 应变化：${before} → ${after}`)
  store.close()
})

test('连续跑两次非 force：第二次 ran:false，reason 今天已经整理过', async () => {
  const store = await mkStore()
  const n = createNightly({ store })

  const first = await n.run({ now: NIGHT })
  assert.equal(first.ran, true)

  const second = await n.run({ now: NIGHT })
  assert.equal(second.ok, false)
  assert.equal(second.ran, false)
  assert.equal(second.reason, '今天已经整理过')
  store.close()
})

test('config：自定义窗口生效，last() 初始为 null', async () => {
  const store = await mkStore()
  const n = createNightly({ store, config: { window: ['01:00', '02:00'] } })
  assert.deepEqual(n.config.window, ['01:00', '02:00'])
  assert.equal(n.last(), null)
  assert.deepEqual(n.due({ now: EARLY }), { ok: true })
  assert.equal(n.due({ now: NIGHT }).reason, '不在夜里')
  store.close()
})
