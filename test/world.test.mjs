// 常识层：brain.json 摊平（权重在 edges 里）、导入的失败口径、概览、未完成线程。
// 全部用临时文件 + 假 store，绝不读真实 brain.json。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { worldFromBrain, importBrain, worldSummary, worldThreads } from '../lib/world.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-world-'))

function brainFileWith(content) {
  const file = path.join(tmp(), 'brain.json')
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  return file
}

function fakeStore(world) {
  const writes = []
  return {
    writes,
    worldWrite(rows) {
      writes.push(rows)
      return { ok: true, elements: rows.elements.length, objects: rows.objects.length }
    },
    worldRead: () => world,
  }
}

test('worldFromBrain：elements 逐个摊平，kind 缺省是未分类，id 用名字', () => {
  const out = worldFromBrain({
    elements: { 苹果: { kind: '食物', aliases: ['apple'] }, 猫: {} },
    objects: {},
  })

  assert.deepEqual(out.elements.map((e) => e.name), ['苹果', '猫'])
  assert.equal(out.elements[0].id, '苹果')
  assert.equal(out.elements[0].kind, '食物')
  assert.equal(out.elements[1].kind, '未分类')
  assert.deepEqual(out.objects, [])
  assert.deepEqual(worldFromBrain({}), { elements: [], objects: [] })
})

test('worldFromBrain：weight 来自 edges 的平均值，observed 是出现的物体数', () => {
  const out = worldFromBrain({
    elements: { A: { kind: '物' }, B: { kind: '物' } },
    objects: { 盒子: {}, 篮子: {} },
    edges: {
      盒子: { A: { w: 0.8, why: '常一起出现' } },
      篮子: { A: { w: 0.6, why: '也一起出现' } },
    },
  })

  const a = out.elements.find((e) => e.name === 'A')
  const b = out.elements.find((e) => e.name === 'B')
  assert.ok(Math.abs(a.weight - 0.7) < 1e-9, `A 的平均权重应是 0.7，实际 ${a.weight}`)
  assert.equal(a.observed, 2)
  assert.equal(b.weight, 0.5, '一次边都没有的元素才是 0.5')
  assert.equal(b.observed, 0)

  // 越界的权重按 0–1 夹住
  const clamped = worldFromBrain({
    elements: { X: {}, Y: {} },
    edges: { 物: { X: { w: 3 }, Y: { w: -2 } } },
  })
  assert.equal(clamped.elements.find((e) => e.name === 'X').weight, 1)
  assert.equal(clamped.elements.find((e) => e.name === 'Y').weight, 0)
})

test('worldFromBrain：objects 的元素带 w/how/why，why 截到 60 字，note 原样带上', () => {
  const why = '很'.repeat(80)
  const out = worldFromBrain({
    elements: { A: {}, B: {} },
    objects: { 盒子: { note: '厨房那个' } },
    edges: {
      盒子: {
        A: { w: 0.9, how: '看见的', why },
        B: {},
      },
    },
  })

  const box = out.objects.find((o) => o.name === '盒子')
  assert.equal(box.note, '厨房那个')
  assert.equal(box.elements.length, 2)
  assert.deepEqual(Object.keys(box.elements[0]), ['name', 'w', 'how', 'why'])
  assert.equal(box.elements[0].name, 'A')
  assert.equal(box.elements[0].w, 0.9)
  assert.equal(box.elements[0].how, '看见的')
  assert.equal(box.elements[0].why.length, 60)
  assert.ok(box.elements[0].why.endsWith('…'))
  assert.equal(box.elements[0].why.slice(0, 5), '很很很很很')
  assert.equal(box.elements[1].w, 0.5, '缺 w 时按 0.5')
  assert.equal(box.elements[1].how, '')
  assert.equal(box.elements[1].why, '')
})

test('worldFromBrain：没有 edges 不抛，objects 的 elements 是空数组', () => {
  const out = worldFromBrain({
    elements: { A: { kind: '人' } },
    objects: { 盒子: { note: '空的' } },
  })

  assert.equal(out.elements.length, 1)
  assert.equal(out.elements[0].weight, 0.5)
  assert.equal(out.elements[0].observed, 0)
  assert.equal(out.objects.length, 1)
  assert.deepEqual(out.objects[0].elements, [])
  assert.equal(out.objects[0].note, '空的')
})

test('importBrain：文件不在/JSON 坏了/顶层不是对象，都是人话 reason，且不写库', () => {
  const store = fakeStore({ elements: [], objects: [] })

  const missing = importBrain({ file: path.join(tmp(), '没有这个文件.json'), store })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, '没找到 brain.json')

  const bad = importBrain({ file: brainFileWith('{ 这不是 JSON'), store })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /JSON/)

  const wrong = importBrain({ file: brainFileWith([]), store })
  assert.equal(wrong.ok, false)
  assert.match(wrong.reason, /顶层不是对象/)

  assert.equal(store.writes.length, 0, '失败时一次 worldWrite 都不能发生')
})

test('importBrain：成功时把摊平后的行交给 worldWrite，并 log 一句、返回条数', async () => {
  const store = fakeStore({ elements: [], objects: [] })
  const logs = []
  const file = brainFileWith({
    elements: { 苹果: { kind: '食物' }, 猫: {} },
    objects: { 篮子: { note: '门口' } },
    edges: { 篮子: { 苹果: { w: 0.7, how: '放进去的', why: '常吃' } } },
  })

  const r = importBrain({ file, store, log: (m) => logs.push(String(m)) })

  assert.equal(r.ok, true)
  assert.equal(r.elements, 2)
  assert.equal(r.objects, 1)
  assert.equal(store.writes.length, 1)
  assert.equal(store.writes[0].elements.length, 2)
  assert.equal(store.writes[0].objects[0].name, '篮子')
  assert.equal(store.writes[0].objects[0].elements[0].w, 0.7)
  assert.deepEqual(logs, ['常识层：2 个元素、1 个物体'])
})

test('worldThreads：unsettled(open) + scenes(untested) 合并、按时间、去重、limit 生效', () => {
  const store = fakeStore({
    elements: [],
    objects: [],
    unsettled: [
      { id: 'u1', what: '同一件事', at: 10, status: 'open' },
      { id: 'u2', what: '很久以前的', at: 1, status: 'open' },
      { id: 'u3', what: '问过了', at: 3, status: 'answered' },
    ],
    scenes: [
      { id: 's1', text: '同一件事', at: 20, status: 'untested' },
      { id: 's2', text: '梦里的场景', at: 5, status: 'untested' },
      { id: 's3', text: '验过了', at: 4, status: 'tested' },
    ],
  })

  const all = worldThreads(store)
  assert.deepEqual(all.map((t) => t.id), ['u2', 's2', 'u1'], '最早的在前面，同一句话只留 unsettled 那条')
  assert.deepEqual(all.map((t) => t.kind), ['unsettled', 'scene', 'unsettled'])
  assert.equal(all[0].text, '很久以前的')
  assert.equal(all[0].what, '很久以前的')
  assert.equal(all[1].text, '梦里的场景')
  assert.equal(all[1].hypothesis, null)

  const two = worldThreads(store, { limit: 2 })
  assert.deepEqual(two.map((t) => t.id), ['u2', 's2'])
  assert.deepEqual(worldThreads(store, { limit: 0 }), [])
})

test('worldSummary：条数、按 kind 计数、top 按权重降序取前 5', () => {
  const store = fakeStore({
    elements: [
      { name: 'A', weight: 0.4, kind: '人' },
      { name: 'B', weight: 0.9, kind: '人' },
      { name: 'C', weight: 0.9, kind: '物' },
      { name: 'D', weight: 0.1, kind: '未分类' },
      { name: 'E', weight: 0.5, kind: '' },
      { name: 'F', weight: 0.2, kind: '物' },
    ],
    objects: [{ name: '盒子' }, { name: '篮子' }],
    scenes: [],
    unsettled: [],
  })

  const s = worldSummary(store)
  assert.equal(s.elements, 6)
  assert.equal(s.objects, 2)
  assert.deepEqual(s.kinds, { 人: 2, 物: 2, 未分类: 2 })
  assert.deepEqual(s.top.map((t) => t.name), ['B', 'C', 'E', 'A', 'F'])
  assert.equal(s.top.length, 5)
  assert.equal(s.top[0].weight, 0.9)
  assert.deepEqual(worldSummary(null), { elements: 0, objects: 0, kinds: {}, top: [] })
})
