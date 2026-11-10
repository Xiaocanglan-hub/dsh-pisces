// 常识层：把 dsh-memory-brain 的 brain.json 摊平进 world.db。
// 权重不在 elements/objects 里，而在 edges[物体][元素].w —— 摊平时要按元素把出现过的 w 取平均。
// 旧实现把 weight 一律写成 0.5，edges 里的权重全丢了（知识库 n21 记的就是这条）。
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { clip, isObject } from './util.js'
import { homeDir } from './paths.js'

const UNKNOWN_KIND = '未分类'
const DEFAULT_W = 0.5
const WHY_MAX = 60
const TOP_N = 5

const clamp01 = (n) => Math.min(1, Math.max(0, n))

/** 数值化；非数就给 fallback（brain 里的 w 偶尔是字符串）。 */
function num(v, fallback = DEFAULT_W) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const kindOf = (v) => (v == null || String(v).trim() === '' ? UNKNOWN_KIND : String(v))
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const textOf = (row, ...keys) => {
  for (const k of keys) {
    const s = oneLine(row?.[k])
    if (s) return s
  }
  return ''
}

/** 默认源：~/.dsh/memory/brain.json（dsh-memory-brain 的常识库）。 */
export function brainFile(env = process.env) {
  return path.join(homeDir(env), '.dsh', 'memory', 'brain.json')
}

/**
 * brain.json → world.db 的行。
 * elements：brain.elements 的每个键；weight 取该元素在 edges 里所有 w 的平均（clamp 0–1），
 * 一次边都没出现过才是 0.5；observed = 出现在多少个物体里。
 * objects：brain.objects 的每个键；elements 摊自 edges[物体名]。
 * 没有 edges（或形状不对）时退化成"每个物体没有元素"，不抛。
 */
export function worldFromBrain(brain = {}) {
  const src = isObject(brain) ? brain : {}
  const elementsIn = isObject(src.elements) ? src.elements : {}
  const objectsIn = isObject(src.objects) ? src.objects : {}
  const edges = isObject(src.edges) ? src.edges : {}

  // 先按 elements 建累加器：权重只算"这个元素出现过的每一条边"，不是"每个物体的权重"。
  const acc = new Map()
  for (const name of Object.keys(elementsIn)) acc.set(name, { sum: 0, n: 0, observed: 0 })
  for (const map of Object.values(edges)) {
    if (!isObject(map)) continue
    for (const [elName, x] of Object.entries(map)) {
      const a = acc.get(elName)
      if (!a) continue
      const e = isObject(x) ? x : {}
      a.sum += num(e.w ?? DEFAULT_W)
      a.n += 1
      a.observed += 1
    }
  }

  const elements = Object.keys(elementsIn).map((name) => {
    const v = isObject(elementsIn[name]) ? elementsIn[name] : {}
    const a = acc.get(name)
    return {
      id: String(name),
      name: String(name),
      kind: kindOf(v.kind),
      weight: a && a.n ? clamp01(a.sum / a.n) : DEFAULT_W,
      observed: a ? a.observed : 0,
    }
  })

  const objects = Object.keys(objectsIn).map((name) => {
    const v = isObject(objectsIn[name]) ? objectsIn[name] : {}
    const map = isObject(edges[name]) ? edges[name] : {}
    const list = Object.entries(map).map(([elName, x]) => {
      const e = isObject(x) ? x : {}
      return {
        name: String(elName),
        w: num(e.w ?? DEFAULT_W),
        how: e.how == null ? '' : String(e.how),
        why: clip(e.why ?? '', WHY_MAX),
      }
    })
    const out = { name: String(name), elements: list }
    if (v.note != null && String(v.note).trim() !== '') out.note = String(v.note)
    return out
  })

  return { elements, objects }
}

/**
 * 读 brain.json 并写进 world.db。
 * 源文件不在 / 读不了 / JSON 坏了：返回人话 reason，绝不把空库写进去。
 * 成功：一个事务覆盖写（worldWrite 是 INSERT OR REPLACE），返回条数。
 */
export function importBrain({ file, store, log = () => {} } = {}) {
  const target = file || brainFile()
  if (!target || !existsSync(target)) return { ok: false, reason: '没找到 brain.json' }

  let raw
  try {
    raw = readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, reason: '没找到 brain.json' }
    return { ok: false, reason: `brain.json 读不了：${e?.message || e}` }
  }

  let brain
  try {
    brain = JSON.parse(raw)
  } catch (e) {
    return { ok: false, reason: `brain.json 不是合法 JSON：${e?.message || e}` }
  }
  if (!isObject(brain)) return { ok: false, reason: 'brain.json 结构不认识：顶层不是对象' }

  const rows = worldFromBrain(brain)
  if (!store || typeof store.worldWrite !== 'function') return { ok: false, reason: '没有可写入的 store' }

  const written = store.worldWrite(rows)
  if (written && written.ok === false) return { ok: false, reason: written.reason || '常识层写不进去' }

  log(`常识层：${rows.elements.length} 个元素、${rows.objects.length} 个物体`)
  return { ok: true, elements: rows.elements.length, objects: rows.objects.length }
}

/** 观测台/`/state` 用的概览：条数、按 kind 分堆、权重最高的几个。 */
export function worldSummary(store) {
  const w = store && typeof store.worldRead === 'function' ? store.worldRead() : null
  const elements = Array.isArray(w?.elements) ? w.elements : []
  const objects = Array.isArray(w?.objects) ? w.objects : []

  const kinds = {}
  for (const e of elements) {
    const k = kindOf(e?.kind)
    kinds[k] = (kinds[k] || 0) + 1
  }

  const top = elements
    .map((e) => ({ name: String(e?.name ?? ''), weight: num(e?.weight) }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, TOP_N)

  return { elements: elements.length, objects: objects.length, kinds, top }
}

/**
 * 未完成的事，给做梦用：world.db 的 unsettled(status='open') + scenes(status='untested')。
 * 同一句话只留最早一条（按 at 升序）；返回数组，每项带 kind 区分来源。
 */
export function worldThreads(store, { limit = 5 } = {}) {
  const w = store && typeof store.worldRead === 'function' ? store.worldRead() : null
  const raw = Number(limit)
  const max = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 5
  if (max === 0) return []

  const items = []
  for (const r of Array.isArray(w?.unsettled) ? w.unsettled : []) {
    if (String(r?.status ?? 'open') !== 'open') continue
    const text = textOf(r, 'what', 'text')
    if (!text) continue
    items.push({
      kind: 'unsettled',
      id: String(r.id ?? ''),
      text,
      what: text,
      at: Number.isFinite(Number(r.at)) ? Number(r.at) : Number.MAX_SAFE_INTEGER,
      status: 'open',
    })
  }
  for (const r of Array.isArray(w?.scenes) ? w.scenes : []) {
    if (String(r?.status ?? 'untested') !== 'untested') continue
    const text = textOf(r, 'text', 'thread')
    if (!text) continue
    items.push({
      kind: 'scene',
      id: String(r.id ?? ''),
      text,
      thread: r.thread == null ? null : String(r.thread),
      counterfactual: r.counterfactual == null ? null : String(r.counterfactual),
      hypothesis: r.hypothesis == null ? null : String(r.hypothesis),
      at: Number.isFinite(Number(r.at)) ? Number(r.at) : Number.MAX_SAFE_INTEGER,
      status: 'untested',
    })
  }

  items.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)))

  const seen = new Set()
  const out = []
  for (const it of items) {
    if (seen.has(it.text)) continue
    seen.add(it.text)
    out.push(it)
    if (out.length >= max) break
  }
  return out
}
