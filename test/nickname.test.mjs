// 昵称：事件流追加，取最后一条；固定名字不变。
// 纯函数 + 一次 append，不碰真库（假 store 足够验事件形状）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { NICKNAME_MAX, nicknameOf, setNickname, validateNickname } from '../lib/nickname.js'

const NOW = Date.parse('2026-11-10T12:00:00+08:00')

function makeStore(events = []) {
  const rows = events.slice()
  const appended = []
  return {
    rows,
    appended,
    readAll: () => rows.slice(),
    async append(input) {
      appended.push(input)
      const ev = { id: `ev_n${rows.length + 1}`, seq: rows.length + 1, day: '2026-11-10', ...input }
      rows.push(ev)
      return ev
    },
  }
}

const nickEvent = (name, ts = NOW, seq = 1) => ({
  id: `ev_${seq}`,
  seq,
  ts,
  type: 'meta',
  text: `nickname:${name}`,
  meta: { kind: 'nickname', name },
})

test('nicknameOf：一条昵称事件都没有时返回 null', () => {
  assert.equal(nicknameOf([]), null)
  assert.equal(nicknameOf(), null)
  assert.equal(nicknameOf([{ type: 'seed', text: '起点。' }, { type: 'meta', meta: { kind: 'demo' } }]), null)
})

test('setNickname：成功追加一条 meta 事件，形状对（文本 / meta.kind / meta.name / ts）', async () => {
  const store = makeStore([nickEvent('阿鱼', NOW - 1000, 1)])
  const r = await setNickname({ store, name: '  小鱼  ', now: NOW })

  assert.equal(r.ok, true)
  assert.equal(r.name, '小鱼')
  assert.deepEqual(store.appended, [
    {
      ts: NOW,
      type: 'meta',
      text: 'nickname:小鱼',
      meta: { kind: 'nickname', name: '小鱼' },
      source: 'owner',
    },
  ])
  assert.equal(r.event.type, 'meta')
  assert.equal(r.event.text, 'nickname:小鱼')
  assert.deepEqual(r.event.meta, { kind: 'nickname', name: '小鱼' })
  assert.equal(nicknameOf(store.rows).name, '小鱼')
})

test('setNickname：空 / 超长 / 换行 / 控制字符被拒，且一条都不写', async () => {
  for (const name of ['', '   ', '字'.repeat(13), '小\n鱼', '小\u0000鱼']) {
    const store = makeStore()
    const r = await setNickname({ store, name, now: NOW })
    assert.equal(r.ok, false, `应当拒绝：${JSON.stringify(name)}`)
    assert.equal(typeof r.reason, 'string')
    assert.equal(store.appended.length, 0)
  }
})

test('setNickname：固定名字与当前昵称都算「这本来就是我的名字」', async () => {
  for (const name of ['派希丝', '大肥鱼']) {
    assert.deepEqual(validateNickname(name), { ok: false, reason: '这本来就是我的名字' })
    const store = makeStore()
    const r = await setNickname({ store, name, now: NOW })
    assert.equal(r.ok, false)
    assert.equal(r.reason, '这本来就是我的名字')
    assert.equal(store.appended.length, 0)
  }

  const store = makeStore([nickEvent('阿鱼', NOW - 1000, 1)])
  const again = await setNickname({ store, name: '阿鱼', now: NOW })
  assert.equal(again.ok, false)
  assert.equal(again.reason, '这本来就是我的名字')
  assert.equal(store.appended.length, 0, '同一个名字不该再写一条')
})

test('nicknameOf：有多条时取最后一条，带 at / seq', () => {
  const events = [
    nickEvent('阿鱼', NOW - 3000, 1),
    { type: 'meta', ts: NOW - 2000, seq: 2, meta: { kind: 'demo' } },
    nickEvent('小鱼', NOW - 1000, 3),
  ]
  assert.deepEqual(nicknameOf(events), { name: '小鱼', at: NOW - 1000, seq: 3 })
})

test('nicknameOf：忽略别的 meta（demo / seen / dream_observed / react / card_patch）', () => {
  const events = [
    { type: 'meta', seq: 1, ts: NOW, meta: { kind: 'demo', name: '派希丝' } },
    { type: 'meta', seq: 2, ts: NOW, text: 'seen:2026-11-10', meta: {} },
    { type: 'meta', seq: 3, ts: NOW, meta: { kind: 'dream_observed' } },
    { type: 'meta', seq: 4, ts: NOW, meta: { kind: 'react', reaction: 'hurt' } },
    { type: 'meta', seq: 5, ts: NOW, meta: { kind: 'card_patch' } },
  ]
  assert.equal(nicknameOf(events), null)
})

test('setNickname：改三次留三条，不覆盖，最后一条生效', async () => {
  const store = makeStore()
  for (const name of ['阿鱼', '小鱼', '阿水']) {
    const r = await setNickname({ store, name, now: NOW })
    assert.equal(r.ok, true)
  }
  assert.equal(store.rows.length, 3)
  assert.equal(store.appended.length, 3)
  assert.deepEqual(
    store.rows.map((e) => e.text),
    ['nickname:阿鱼', 'nickname:小鱼', 'nickname:阿水'],
  )
  assert.equal(nicknameOf(store.rows).name, '阿水')
})

test('validateNickname：边界 1 / 12 通过、13 不过；首尾空白会去掉', () => {
  assert.equal(NICKNAME_MAX, 12)
  assert.deepEqual(validateNickname('鱼'), { ok: true, name: '鱼' })
  assert.deepEqual(validateNickname('鱼'.repeat(12)), { ok: true, name: '鱼'.repeat(12) })
  assert.equal(validateNickname('鱼'.repeat(13)).ok, false)
  assert.deepEqual(validateNickname('  鱼  '), { ok: true, name: '鱼' })
})
