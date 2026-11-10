// 成年鱼：领养样本、demo 标记只认事件流、两个缺省值。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'
import { deriveSelf } from '../lib/derive.js'
import { readCard } from '../lib/card.js'
import { readSoulBundle, verifySoulBundle } from '../lib/export.js'
import { ADULT_LABEL, ADULT_NAME } from '../lib/teach.js'
import { adoptAdult, demoLabel, demoName, isDemo } from '../lib/adopt.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ADULT_FILE = path.resolve(HERE, '..', 'assets', 'adult-fish.soul.json')
const NOW = Date.now()

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-adopt-'))
  const store = await createStore({ root: path.join(root, 'store'), forceJsonl: true })
  return { root, store }
}

// 1：资产自证 + 领养成功
test('adopt：96 条样本自证通过，领养带出名字/起点/demo，判断/拒绝/疤都在', async () => {
  const doc = readSoulBundle(ADULT_FILE)
  assert.equal(doc.events.length, 96)
  const verdict = verifySoulBundle(doc)
  assert.deepEqual(verdict.problems, [])
  assert.equal(verdict.ok, true)
  assert.equal(doc.chain.ok, true)

  const { root, store } = await mkStore()
  const r = await adoptAdult({ root, store, file: ADULT_FILE, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.name, ADULT_NAME)
  assert.equal(r.label, ADULT_LABEL)
  assert.equal(r.demo, true)
  assert.ok(r.events >= 90, `事件数应该 ≥90，实际 ${r.events}`)
  assert.equal(r.events, 96)
  assert.ok(r.firstId && r.lastId)
  assert.equal(store.count(), 96)
  assert.equal(store.verify().ok, true)

  const d = deriveSelf(store.readAll(), { now: NOW })
  assert.ok(d.beliefs.length > 0, '判断应该还在')
  assert.equal(d.refusals.length, 4)
  assert.equal(d.scars.length, 2)

  const card = readCard(root)
  assert.equal(card.self.startsWith('# 我'), true)
  assert.ok(card.self.includes('我是派希丝'))
  store.close()
})

// 1b：新样本先认群体（大肥鱼），再认名字（派希丝）
test('adopt：新样本的 seed 与卡都带着「大肥鱼」这个群体身份', async () => {
  const doc = readSoulBundle(ADULT_FILE)
  const seedText = doc.events.filter((e) => e.type === 'seed').map((e) => e.text).join('\n')
  assert.ok(seedText.includes('大肥鱼'), 'seed 里没有「大肥鱼」')
  assert.ok(doc.card.self.includes('大肥鱼'), '卡的 self 里没有「大肥鱼」')

  const { root, store } = await mkStore()
  const r = await adoptAdult({ root, store, file: ADULT_FILE, now: NOW })
  assert.equal(r.ok, true)
  const adoptedSeed = store.readAll().filter((e) => e.type === 'seed').map((e) => e.text).join('\n')
  assert.ok(adoptedSeed.includes('大肥鱼'))
  assert.ok(readCard(root).self.includes('大肥鱼'))
  store.close()
})

// 2：已有起点拒绝，且一个事件都不动
test('adopt：已经有起点就拒绝，事件流一条都不多', async () => {
  const { root, store } = await mkStore()
  await store.append({ type: 'seed', text: '我自己写的起点。', ts: NOW - 1000, source: 'owner' })
  const before = store.count()

  const r = await adoptAdult({ root, store, file: ADULT_FILE, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '已经有起点了，不能再领养')
  assert.equal(store.count(), before)
  assert.equal(isDemo(store.readAll()), false)
  store.close()
})

// 3：文件不存在 / 格式不对，都要明说
test('adopt：文件不存在说"找不到数据包"，不是本格式说"不是这个项目的 soul bundle"', async () => {
  const { root, store } = await mkStore()

  const missing = await adoptAdult({ root, store, file: path.join(root, 'nope.soul.json'), now: NOW })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, '找不到成年鱼的数据包')
  assert.equal(store.count(), 0)

  const badFile = path.join(root, 'other.soul.json')
  writeFileSync(badFile, `${JSON.stringify({ format: 'something/else', version: 1, events: [] })}\n`, 'utf8')
  const bad = await adoptAdult({ root, store, file: badFile, now: NOW })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, '不是这个项目的 soul bundle')
  assert.equal(store.count(), 0)
  store.close()
})

// 4：配置说什么都不算，只认事件流
test('isDemo：只认事件流里的 meta.kind=demo，配置传什么都不算', () => {
  assert.equal(isDemo([]), false)
  assert.equal(isDemo([{ type: 'meta', meta: { kind: 'other' } }]), false)
  assert.equal(isDemo([{ type: 'meta', meta: { kind: 'demo' } }]), true)
  assert.equal(isDemo([{ type: 'meta', meta: { kind: 'other' } }], { demo: true }), false)
  assert.equal(isDemo([{ type: 'meta', meta: { kind: 'demo' } }], { demo: false }), true)
})

// 5：缺省名字与缺省那句话
test('demoName/demoLabel：缺省是派希丝与那句起点，有 meta 就照 meta', () => {
  assert.equal(demoName([]), ADULT_NAME)
  assert.equal(demoLabel([]), ADULT_LABEL)
  assert.equal(demoName([{ meta: { kind: 'demo', name: '别的名字' } }]), '别的名字')
  assert.equal(demoLabel([{ meta: { kind: 'demo', label: '别的起点' } }]), '别的起点')
  assert.equal(demoName([{ meta: { kind: 'demo', name: '   ' } }]), ADULT_NAME)
  assert.equal(demoLabel([{ meta: { kind: 'demo', label: '' } }]), ADULT_LABEL)
})
