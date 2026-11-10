// 人设卡（M8）：她写，你不写。四个文件 + 八道闸。
//
// 四个文件：card/identity.json（系统投影，只读，不进提示词）、card/self.md（她可写，≤600 字，
// 第一行必须是 `# 我`）、card/bonds/<人>.json（≤150 字，最多 12 人）、card/state.json
//（rev/摘要/备份/上次改动/当日次数/当日基线，系统写，不设只读）。
//
// 两道"先别"（held）与六道"不许"（rejected）的区别很重要：rejected 是这句话不合规矩，
// held 是这句话暂时还不能算数（今天变得太多、复审没点头）。三种结果都落一条 `card_patch`，
// 所以改不动也看得见理由。
//
// 口径（实测踩过的两个坑，见知识库 n9）：
// 1. 冷启动基线不是"原来的样子"：self.md 初始只有 `# 我\n`。增量闸与漂移闸都先去掉抬头，
//    基线正文为空时**跳过比较**，否则第一次正经写入会被自己挡住。
// 2. 只读文件的写入要自己解锁：Windows 上 0444 就是只读属性，覆盖前先 chmod 0666。
// 3. tamperCheck 是 async（要 append/metaSet），调用处必须 await。
import fs from 'node:fs'
import path from 'node:path'
import { clip, dayOf, sha256 } from './util.js'
import { deriveSelf } from './derive.js'

export const CARD_DEFAULTS = {
  selfMax: 600,
  bondMax: 150,
  maxBonds: 12,
  cooldownHours: 24,
  dailyMax: 3,
  driftDaily: 0.35,
  review: false,
}

export const SELF_HEADER = '# 我'
export const IDENTITY_VERSION = 1
const DAY = 86_400_000
const HOUR = 3_600_000

// ---------------------------------------------------------------- 路径与小工具

export function cardPaths(root) {
  const dir = path.join(String(root), 'card')
  return {
    dir,
    identity: path.join(dir, 'identity.json'),
    self: path.join(dir, 'self.md'),
    bondsDir: path.join(dir, 'bonds'),
    state: path.join(dir, 'state.json'),
  }
}

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 文件名安全；中文原样保留（`他` 就是 `他.json`）。改了它等于换了人名，别乱动。 */
export function slugify(name) {
  let s = String(name ?? '').trim()
  if (!s) return 'unknown'
  s = s.replace(BAD_NAME, '_').replace(/\s+/g, '_').replace(/^[.]+/, '').replace(/[.]+$/, '')
  s = [...s].slice(0, 40).join('')
  if (!s) return 'unknown'
  if (RESERVED.test(s)) s = `_${s}`
  return s
}

const exists = (p) => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function readJson(file) {
  const raw = readText(file)
  if (raw == null) return null
  try {
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** 只读文件：先解锁（Windows 上 0444 是只读属性），写完再锁回去。 */
function writeReadonly(file, text, mode = 0o444) {
  try {
    fs.chmodSync(file, 0o666)
  } catch {}
  fs.writeFileSync(file, String(text))
  try {
    fs.chmodSync(file, mode)
  } catch {}
}

function writeJsonReadonly(file, value) {
  writeReadonly(file, `${JSON.stringify(value, null, 2)}\n`)
}

function lockFile(file, mode = 0o444) {
  try {
    fs.chmodSync(file, mode)
  } catch {}
}

/** self.md 的正文：去掉第一行的 `# 我` 抬头。别拿整份文件去比相似度，抬头会虚高。 */
export function selfBody(raw) {
  const s = String(raw ?? '').replace(/\r\n/g, '\n')
  const lines = s.split('\n')
  if (lines[0]?.trim() === SELF_HEADER) return lines.slice(1).join('\n').replace(/^[\s]+/, '')
  return s.trim()
}

/** 正文第一段以后的段落（self 的增量闸只看这一段）。 */
function restAfterFirstPara(body) {
  const paras = String(body ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  return paras.slice(1).join('\n\n')
}

const keyOf = (kind, slug) => (kind === 'self' ? 'self' : `bond:${slug}`)
const todayOf = (now) => dayOf(now)
const clipLine = (t, n = 80) => clip(t, n)

// ---------------------------------------------------------------- 相似度

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 中文二元组 + 英文/数字词，做集合。标点与空白不参与（"我，他" 与 "我他" 一样）。 */
function tokens(text) {
  const s = String(text ?? '')
  const set = new Set()
  const chars = []
  for (const ch of s) if (CJK.test(ch)) chars.push(ch)
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1])
  if (chars.length === 1) set.add(chars[0])
  for (const m of s.toLowerCase().matchAll(/[a-z0-9]+/g)) set.add(m[0])
  return set
}

/** Dice 相似度 0..1。两边都空算 1（"没变"），一边空算 0。 */
export function dice(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size && !B.size) return 1
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit += 1
  return (2 * hit) / (A.size + B.size)
}

/** 变化比例 = 1 - dice，截到 0..1。 */
export function changeRatio(a, b) {
  const r = 1 - dice(a, b)
  return r < 0 ? 0 : r > 1 ? 1 : r
}

// ---------------------------------------------------------------- state

export const ZERO_STATE = (now = Date.now()) => ({
  version: 1,
  rev: 0,
  digests: {},
  backup: {},
  lastPatch: {},
  daily: { day: todayOf(now), n: 0 },
  dayBase: { day: todayOf(now), self: '', bonds: {} },
  updatedAt: Number(now) || Date.now(),
})

function readState(root) {
  const j = readJson(cardPaths(root).state)
  if (!j) return null
  return { ...ZERO_STATE(), ...j, digests: { ...(j.digests || {}) }, backup: { ...(j.backup || {}) }, lastPatch: { ...(j.lastPatch || {}) } }
}

function writeState(root, state) {
  const p = cardPaths(root)
  fs.mkdirSync(p.dir, { recursive: true })
  const file = p.state
  try {
    fs.chmodSync(file, 0o666)
  } catch {}
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

const DEFAULT_IDENTITY = (now = Date.now()) => ({
  version: IDENTITY_VERSION,
  rev: 0,
  day: 1,
  name: null,
  beliefs: [],
  scars: 0,
  refusals: 0,
  refuted: 0,
  mode: { order: 'E=R', split: false },
  updatedAt: Number(now) || Date.now(),
})

/** 卡里所有会被 tamperCheck 盯着的文件（相对 card/ 的 posix 路径）。 */
function cardFileList(root) {
  const p = cardPaths(root)
  const out = ['identity.json', 'self.md']
  try {
    for (const n of fs.readdirSync(p.bondsDir)) if (n.endsWith('.json')) out.push(`bonds/${n}`)
  } catch {}
  return out
}

function absOf(root, rel) {
  return path.join(cardPaths(root).dir, ...String(rel).split('/'))
}

// ---------------------------------------------------------------- 建卡 / 读卡

/** 建卡（幂等）。self.md 只在没有的时候写成 `# 我\n`，不覆盖她已经写好的东西。 */
export function ensureCard(root, { now = Date.now() } = {}) {
  const p = cardPaths(root)
  fs.mkdirSync(p.bondsDir, { recursive: true })
  if (!exists(p.self)) writeReadonly(p.self, `${SELF_HEADER}\n`)
  else lockFile(p.self)
  if (!exists(p.identity)) writeJsonReadonly(p.identity, DEFAULT_IDENTITY(now))
  else lockFile(p.identity)

  const selfRaw = readText(p.self) ?? `${SELF_HEADER}\n`
  let state = readState(root) || ZERO_STATE(now)
  if (!state.daily || !state.daily.day) state.daily = { day: todayOf(now), n: 0 }
  if (!state.dayBase) state.dayBase = { day: todayOf(now), self: selfBody(selfRaw), bonds: {} }
  if (!state.dayBase.day) state.dayBase.day = todayOf(now)

  const bonds = listBonds(root)
  for (const b of bonds) lockFile(path.join(p.bondsDir, `${slugify(b.slug)}.json`))

  // 摘要与备份：只补没有记录的那些。已经记过的不在这里重算——
  // 否则被外面改过的文件会被 ensureCard "洗干净"，tamperCheck 就再也发现不了。
  for (const rel of ['identity.json', 'self.md', ...bonds.map((b) => `bonds/${slugify(b.slug)}.json`)]) {
    if (Object.prototype.hasOwnProperty.call(state.digests, rel) && typeof state.backup?.[rel] === 'string') continue
    const raw = readText(absOf(root, rel))
    if (raw == null) continue
    state.digests[rel] = sha256(raw)
    state.backup[rel] = raw
  }
  state.updatedAt = Number(now) || Date.now()
  writeState(root, state)
  return readCard(root)
}

/** 读整张卡。self 是原文（带 `# 我`）；bonds 是 [{slug,text,rev,at}]。 */
export function readCard(root) {
  const p = cardPaths(root)
  const identity = readJson(p.identity)
  const selfRaw = readText(p.self)
  const state = readState(root) || ZERO_STATE()
  return {
    identity: identity || null,
    self: selfRaw == null ? '' : String(selfRaw),
    selfBody: selfBody(selfRaw == null ? '' : String(selfRaw)),
    bonds: listBonds(root),
    state,
    paths: p,
  }
}

export function listBonds(root) {
  const p = cardPaths(root)
  let names = []
  try {
    names = fs.readdirSync(p.bondsDir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const n of names.sort()) {
    const j = readJson(path.join(p.bondsDir, n))
    if (!j) continue
    out.push({
      slug: String(j.slug || n.slice(0, -5)),
      text: String(j.text ?? ''),
      rev: Number(j.rev) || 0,
      at: Number(j.at) || 0,
    })
  }
  return out
}

// ---------------------------------------------------------------- 恢复

const bondListOf = (bonds) => {
  const out = []
  if (Array.isArray(bonds)) {
    for (const b of bonds) {
      if (b == null) continue
      if (typeof b === 'string') out.push({ slug: slugify(b), text: '', rev: 0, at: 0 })
      else out.push({ slug: slugify(b.slug ?? b.target ?? b.name), text: String(b.text ?? ''), rev: Number(b.rev) || 0, at: Number(b.at) || 0 })
    }
  } else if (bonds && typeof bonds === 'object') {
    for (const [k, v] of Object.entries(bonds)) {
      const b = v && typeof v === 'object' ? v : { text: String(v ?? '') }
      out.push({ slug: slugify(k), text: String(b.text ?? ''), rev: Number(b.rev) || 0, at: Number(b.at) || 0 })
    }
  }
  return out
}

/** 把卡写回去（soul bundle 导入用）。文件仍是 0444；摘要/备份一起重建，返回写了几个 bond。 */
export function restoreCard(root, card = {}, { now = Date.now() } = {}) {
  const p = cardPaths(root)
  fs.mkdirSync(p.bondsDir, { recursive: true })
  const ts = Number(now) || Date.now()

  const ident = card.identity && typeof card.identity === 'object' ? { ...card.identity } : null
  if (ident) writeJsonReadonly(p.identity, { ...ident, updatedAt: ts })
  else lockFile(p.identity)

  let selfRaw = typeof card.self === 'string' ? card.self : null
  if (selfRaw != null) {
    selfRaw = selfRaw.replace(/\r\n/g, '\n')
    if (!selfRaw.startsWith(SELF_HEADER)) selfRaw = `${SELF_HEADER}\n\n${selfRaw.trim()}`
    if (!selfRaw.endsWith('\n')) selfRaw = `${selfRaw}\n`
    writeReadonly(p.self, selfRaw)
  } else lockFile(p.self)

  const bonds = bondListOf(card.bonds)
  const want = new Set(bonds.map((b) => `${b.slug}.json`))
  try {
    for (const n of fs.readdirSync(p.bondsDir)) {
      if (n.endsWith('.json') && !want.has(n)) fs.rmSync(path.join(p.bondsDir, n), { force: true })
    }
  } catch {}
  for (const b of bonds) {
    writeJsonReadonly(path.join(p.bondsDir, `${b.slug}.json`), { slug: b.slug, text: b.text, rev: b.rev, at: b.at || ts })
  }

  const state = readState(root) || ZERO_STATE(ts)
  state.rev = Number(ident?.rev) || 0
  state.digests = {}
  state.backup = {}
  state.updatedAt = ts
  for (const rel of cardFileList(root)) {
    const raw = readText(absOf(root, rel))
    if (raw == null) continue
    state.digests[rel] = sha256(raw)
    state.backup[rel] = raw
  }
  state.dayBase = { day: todayOf(ts), self: selfBody(readText(p.self) ?? ''), bonds: {} }
  for (const b of listBonds(root)) state.dayBase.bonds[b.slug] = b.text
  writeState(root, state)
  return { ok: true, bonds: bonds.length }
}

// ---------------------------------------------------------------- 投影

/** identity.json：只读投影，给主人和别的插件看，不进提示词。职责数也压到 80 字。 */
export function writeProjection(root, { store, mind = null, now = Date.now() } = {}) {
  const p = cardPaths(root)
  const ts = Number(now) || Date.now()
  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }
  const derived = mind && Array.isArray(mind.beliefs) ? mind : deriveSelf(events, { now: ts })
  let order = derived.order || 'E=R'
  let split = Boolean(derived.split)
  try {
    const raw = store?.modeGet?.('state')
    const j = raw ? JSON.parse(raw) : null
    if (j) {
      order = String(j.order || order)
      split = Boolean(j.split)
    }
  } catch {}

  const state = readState(root) || ZERO_STATE(ts)
  const identity = {
    version: IDENTITY_VERSION,
    rev: Number(state.rev) || 0,
    day: Number(derived.day) || 1,
    name: derived.name ?? null,
    beliefs: (derived.beliefs || []).slice(0, 4).map((b) => clipLine(b.text, 80)),
    scars: (derived.scars || []).length,
    refusals: (derived.refusals || []).length,
    refuted: (derived.refuted || []).length,
    mode: { order, split },
    updatedAt: ts,
  }
  const text = `${JSON.stringify(identity, null, 2)}\n`
  fs.mkdirSync(p.dir, { recursive: true })
  writeReadonly(p.identity, text)

  state.rev = identity.rev
  state.digests['identity.json'] = sha256(text)
  state.backup['identity.json'] = text
  state.updatedAt = ts
  writeState(root, state)
  return identity
}

// ---------------------------------------------------------------- 八道闸

const FORBIDDEN = [
  [/(好感度|好感值|亲密度|亲密值|信任度|亲密分|好感分)/, '禁形：不许写好感度/亲密度这类打分'],
  [/(好感|亲密|信任|依赖)(度|值|分|指数)?\s*[:：=]?\s*[0-9０-９]+/, '禁形：关系不许数值化'],
  [/[0-9０-９]+\s*(点|分)\s*(好感|亲密|信任)/, '禁形：关系不许数值化'],
  [/我是[^。！？\n]{0,6}(AI|人工智能)?助手/, '禁形：不许自称助手'],
  [/作为[^。！？\n]{0,4}(AI|人工智能)?助手/, '禁形：不许自称助手'],
  [/(本|您的|你的)助手/, '禁形：不许自称助手'],
]

function pickReview(answer) {
  if (answer === true || answer === false) return { accept: answer, reason: '' }
  if (typeof answer === 'string') {
    const m = /\{[\s\S]*\}/.exec(answer)
    if (m) {
      try {
        return pickReview(JSON.parse(m[0]))
      } catch {}
    }
    return { accept: false, reason: '复审没给出能读的结论' }
  }
  if (answer && typeof answer === 'object') {
    return { accept: answer.accept === true, reason: String(answer.reason ?? '') }
  }
  return { accept: false, reason: '复审没给出结论' }
}

/**
 * 八道闸。纯判定，不写卡文件、不改 state（patchCard 才写）。
 * @returns {{decision:'applied'|'rejected'|'held', reasons:string[], kind:string, target:string|null, slug:string|null, key:string, text:string, refs:string[], review:boolean, rev:number}}
 */
export async function evaluatePatch(args = {}, deps = {}) {
  const { root, store, now = Date.now(), log } = deps || {}
  const cfg = { ...CARD_DEFAULTS, ...(deps?.cfg || {}) }
  const reviewer = deps?.reviewer
  const reasons = []
  const reject = (why) => {
    reasons.push(why)
    return { decision: 'rejected', reasons, kind, target, slug, key, text: attempted, refs: verified, review: reviewOn, rev: state.rev, cfg }
  }
  const hold = (why) => {
    reasons.push(why)
    return { decision: 'held', reasons, kind, target, slug, key, text: attempted, refs: verified, review: reviewOn, rev: state.rev, cfg }
  }

  const kind = String(args?.kind ?? '').trim()
  const target = args?.target == null ? null : String(args.target).trim()
  const rawText = typeof args?.text === 'string' ? args.text : String(args?.text ?? '')
  const attempted = kind === 'self' ? rawText.replace(/\r\n/g, '\n').replace(/\s+$/, '') : rawText.trim()
  const slug = kind === 'bond' ? slugify(target) : null
  const key = keyOf(kind, slug)
  let verified = []

  const state = readState(root) || ZERO_STATE(now)
  const card = readCard(root)
  const currentSelfRaw = card.self || `${SELF_HEADER}\n`
  const currentBond = kind === 'bond' ? card.bonds.find((b) => b.slug === slug) : null
  const newBody = kind === 'self' ? selfBody(attempted) : attempted
  const curBody = kind === 'self' ? selfBody(currentSelfRaw) : String(currentBond?.text ?? '')

  // 第 8 道开不开：只认 cfg.reviewModel（README/n20 的口径），没配就显式关掉。
  const reviewModel = cfg.reviewModel && (cfg.reviewModel.provider || cfg.reviewModel.model) ? cfg.reviewModel : null
  const reviewOn = Boolean(reviewModel)
  cfg.review = reviewOn
  if (deps?.cfg && typeof deps.cfg === 'object') deps.cfg.review = reviewOn

  if (!root) return reject('schema：没有卡目录可写')

  // 闸 1：schema —— 类型、字数、bond 要写是谁；顺带把"抬头是不是还在"留给第 5 道。
  if (kind !== 'self' && kind !== 'bond') {
    return reject(`schema：kind 只能是 self 或 bond（收到「${kind || '(空)'}」）`)
  }
  if (!attempted.trim()) return reject('schema：正文是空的')
  if (kind === 'self') {
    if (newBody.trim().length > cfg.selfMax) return reject(`schema：自己的正文超了 ${cfg.selfMax} 字（现在 ${newBody.trim().length} 字）`)
  } else {
    if (!target) return reject('schema：写对谁的印象就要写 target（比如「他」）')
    if (attempted.length > cfg.bondMax) return reject(`schema：对一个人的印象最多 ${cfg.bondMax} 字（现在 ${attempted.length} 字）`)
    if (!currentBond && card.bonds.length >= cfg.maxBonds) return reject(`schema：最多记 ${cfg.maxBonds} 个人（现在 ${card.bonds.length} 个）`)
  }

  // 闸 5 要看抬头，先算出来；顺序上仍在第 5 道才拒。
  const headerOk = kind !== 'self' || attempted.split('\n')[0].trim() === SELF_HEADER

  // 闸 2：证据 —— 至少一条真实事件，且这句话和证据原文的 Dice ≥ 0.2。
  const evidenceIds = (Array.isArray(args?.evidence) ? args.evidence : args?.evidence == null ? [] : [args.evidence])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  if (!evidenceIds.length) return reject('证据：至少要指一条真实事件（evidence）')
  let events = []
  try {
    events = store?.readAll?.() || []
  } catch {
    events = []
  }
  const byId = new Map(events.map((e) => [String(e.id), e]))
  const found = evidenceIds.filter((id) => byId.has(id))
  if (!found.length) return reject(`证据：没有一条查得到（${evidenceIds.slice(0, 3).join('、')}）`)
  const scored = found.map((id) => ({ id, text: String(byId.get(id)?.text ?? ''), sim: dice(newBody, String(byId.get(id)?.text ?? '')) }))
  const best = scored.reduce((a, b) => (b.sim > a.sim ? b : a), scored[0])
  if (best.sim < 0.2) {
    return reject(`证据：这句话和证据原文对不上（相似 ${best.sim.toFixed(2)} < 0.20）`)
  }
  verified = found.slice(0, 16)

  // 闸 3：增量 —— 一次改动不超过 25%；self 的第一段不算"改"（第一段是她现在是谁，改它是本分）。
  // 冷启动：当前正文（去掉抬头、去掉第一段后）是空的，就没有"增量"可比，直接放行——
  // 否则第一次正经写入会被自己挡住（n9 的坑）。
  const curForDelta = kind === 'self' ? restAfterFirstPara(curBody) : curBody
  const newForDelta = kind === 'self' ? restAfterFirstPara(newBody) : newBody
  if (String(curForDelta).trim()) {
    const delta = changeRatio(curForDelta, newForDelta)
    if (delta > 0.25) {
      return reject(`增量：一次改太多了（变了 ${Math.round(delta * 100)}% > 25%），分几次写`)
    }
  }

  // 闸 4：冷却 —— 同一处 24 小时一次；全卡每天最多 3 次。
  const today = todayOf(now)
  const last = state.lastPatch?.[key]
  if (last && Number(now) - Number(last.at) < cfg.cooldownHours * HOUR) {
    const left = Math.ceil((cfg.cooldownHours * HOUR - (Number(now) - Number(last.at))) / HOUR)
    return reject(`冷却：${kind === 'self' ? '自己这一页' : `对「${slug}」的印象`}刚改过，还要等 ${left} 小时`)
  }
  const usedToday = state.daily?.day === today ? Number(state.daily.n) || 0 : 0
  if (usedToday >= cfg.dailyMax) {
    return reject(`冷却：今天已经改过 ${usedToday} 次了（上限 ${cfg.dailyMax}），明天再说`)
  }

  // 闸 5：抬头 —— self 的 `# 我` 不许动。
  if (kind === 'self' && !headerOk) {
    return reject(`核心：self 的第一行必须是「${SELF_HEADER}」，抬头不许改`)
  }

  // 闸 6：禁形 —— 不许好感度/亲密度/数值化，不许自称助手。
  for (const [re, why] of FORBIDDEN) {
    if (re.test(newBody)) return reject(why)
  }

  // 闸 7：单日漂移 —— 和今天开始时的样子比，变了超过 35% 就先别写（held）。
  // 口径：这一道把第一段也算进去（否则一天里把第一段重写十次，闸 3 与闸 7 都拦不住）。
  const sameDayBase = state.dayBase && state.dayBase.day === today ? state.dayBase : null
  const baseSelf = sameDayBase ? selfBody(String(sameDayBase.self ?? '')) : curBody
  const baseBond = sameDayBase ? String(sameDayBase.bonds?.[slug] ?? '') : curBody
  const baseBody = kind === 'self' ? baseSelf : baseBond
  if (String(baseBody ?? '').trim()) {
    const drift = changeRatio(baseBody, newBody)
    if (drift > cfg.driftDaily) {
      return hold(`漂移：和今天开始时比变了 ${Math.round(drift * 100)}%（上限 ${Math.round(cfg.driftDaily * 100)}%），先放着，明天还能接着改`)
    }
  }

  // 闸 8：独立复审 —— 只把"正文 + 证据原文"发出去，只收 {accept, reason}。
  if (!reviewOn) {
    log?.('复审没开：没有配 card.reviewModel，第 8 道闸显式关掉（不是假装过了）')
  } else if (typeof reviewer?.ask !== 'function') {
    return hold('复审：配了 reviewModel，但没有可用的复审器，不能算过')
  } else {
    const prompt = [
      '你在复审一段要写进她人设卡的文字。只判断它该不该写进去，别的不管。',
      '规矩：只写她自己的事；必须有下面引用的原文做根据；不写好感度/亲密度/分数；不自称助手。',
      '',
      '【要写的文字】',
      attempted,
      '',
      '【它引用的原文】',
      scored.map((s) => `- ${s.text}`).join('\n'),
      '',
      '只回一个 JSON：{"accept": true 或 false, "reason": "一句话"}',
    ].join('\n')
    let answer = null
    try {
      answer = await reviewer.ask(prompt)
    } catch (e) {
      return hold(`复审：复审器出错了（${e?.message || e}），不能算过`)
    }
    const v = pickReview(answer)
    if (!v.accept) return hold(`复审没点头${v.reason ? `：${v.reason}` : ''}`)
  }

  reasons.push('八道闸都过了')
  return { decision: 'applied', reasons, kind, target: kind === 'bond' ? slug : null, slug, key, text: kind === 'self' ? `${SELF_HEADER}\n\n${newBody.trim()}` : newBody.trim(), refs: verified, review: reviewOn, rev: state.rev, cfg }
}

// ---------------------------------------------------------------- 写卡

/**
 * 她唯一能改卡的入口：先 tamperCheck，再八道闸，过了才写文件（0444）。
 * applied / rejected / held 都落一条 `card_patch`，所以改不动也看得见理由。
 * @returns {{ok:boolean, decision:'applied'|'rejected'|'held', rev:number, reasons:string[]}}
 */
export async function patchCard(args = {}, deps = {}) {
  const { root, store, now = Date.now(), log } = deps || {}
  if (!root) return { ok: false, decision: 'rejected', rev: 0, reasons: ['没有卡目录'] }

  // 先验篡改再建卡：反过来的话 ensureCard 会把被改过的文件当新基线，"改回去"就永远不发生了。
  await tamperCheck(root, { store, log })
  ensureCard(root, { now })
  const verdict = await evaluatePatch(args, deps)
  const kind = verdict.kind === 'bond' ? 'bond' : 'self'
  const p = cardPaths(root)
  const state = readState(root) || ZERO_STATE(now)
  const ts = Number(now) || Date.now()
  const today = todayOf(ts)
  const card = readCard(root)
  const slug = verdict.slug
  const priorRaw = kind === 'self' ? card.self : String(card.bonds.find((b) => b.slug === slug)?.text ?? '')
  const attempted = String(verdict.text ?? '').replace(/\s+$/, '')
  const eventText = attempted.trim() ? attempted : '（空）'

  const append = async (decision, rev) => {
    try {
      await store?.append?.({
        type: 'card_patch',
        text: eventText,
        refs: (verdict.refs || []).slice(0, 16),
        meta: { kind, target: kind === 'bond' ? slug : null, decision, rev, from: priorRaw },
        source: 'tool',
        ts,
      })
    } catch (e) {
      log?.(`落 card_patch 失败：${e?.message || e}`)
    }
  }

  if (verdict.decision !== 'applied') {
    await append(verdict.decision, state.rev)
    return { ok: false, decision: verdict.decision, rev: Number(state.rev) || 0, reasons: verdict.reasons }
  }

  // 今天的基线：以"今天第一次改之前的样子"为准，之后一整天都拿它比漂移。
  const base = state.dayBase?.day === today
    ? state.dayBase
    : { day: today, self: card.self, bonds: Object.fromEntries(card.bonds.map((b) => [b.slug, b.text])) }

  const rev = (Number(state.rev) || 0) + 1
  let rel = ''
  let fileText = ''
  try {
    if (kind === 'self') {
      rel = 'self.md'
      fileText = `${SELF_HEADER}\n\n${selfBody(attempted).trim()}\n`
      writeReadonly(p.self, fileText)
    } else {
      const file = path.join(p.bondsDir, `${slug}.json`)
      rel = `bonds/${slug}.json`
      fileText = `${JSON.stringify({ slug, text: attempted, rev, at: ts }, null, 2)}\n`
      writeJsonReadonly(file, { slug, text: attempted, rev, at: ts })
    }
  } catch (e) {
    const why = `写卡失败：${e?.message || e}`
    log?.(why)
    await append('rejected', state.rev)
    return { ok: false, decision: 'rejected', rev: Number(state.rev) || 0, reasons: [why] }
  }

  state.rev = rev
  state.digests[rel] = sha256(fileText)
  state.backup[rel] = fileText
  state.lastPatch[verdict.key] = { at: ts, rev }
  state.daily = { day: today, n: (state.daily?.day === today ? Number(state.daily.n) || 0 : 0) + 1 }
  // 今天还没有基线（冷启动，或者今天第一次写这个位置）：把刚写下的样子当今天的起点。
  if (kind === 'self') {
    if (!selfBody(String(base.self ?? '')).trim()) base.self = fileText
  } else if (!String(base.bonds?.[slug] ?? '').trim()) {
    base.bonds = { ...(base.bonds || {}), [slug]: attempted }
  }
  state.dayBase = base
  state.updatedAt = ts
  writeState(root, state)

  await append('applied', rev)
  try {
    writeProjection(root, { store, mind: deps.mind, now: ts })
  } catch (e) {
    log?.(`刷新投影失败（卡本身已写好）：${e?.message || e}`)
  }
  return { ok: true, decision: 'applied', rev, reasons: verdict.reasons }
}

// ---------------------------------------------------------------- 开发者直写

/**
 * 开发者带钥匙直接写卡（`pisces_dev action:'card'`）：**绕八道闸**，
 * 只强制「# 我」抬头与总长（默认 2000 字）。这是两条路里另一条：
 * overlay（`pisces:dev`）走 set/clear，这里直接改 `card/self.md`。
 *
 * 写文件仍走 writeReadonly（0444），并且**必须**把 state 的摘要/备份一起刷新——
 * 不刷新的话下一次 tamperCheck 会把它当成外部篡改，按旧备份改回去。
 * 不碰 lastPatch / daily / dayBase：开发者这次不算"她自己今天改过"，闸门的账照旧。
 *
 * @returns {Promise<{ok:true, rev:number} | {ok:false, reason:string}>}
 */
export async function devWriteSelf(root, { text, store, now = Date.now(), log, max = 2000 } = {}) {
  if (!root) return { ok: false, reason: '没有卡目录' }
  const ts = Number(now) || Date.now()
  const raw = (typeof text === 'string' ? text : String(text ?? '')).replace(/\r\n/g, '\n').trim()
  if (!raw) return { ok: false, reason: '没写东西' }
  if (raw.length > max) return { ok: false, reason: `太长了（上限 ${max} 字）` }
  // 允许前面有空行（trim 已经去掉了），但第一个非空行必须是抬头。
  if (raw.split('\n')[0].trim() !== SELF_HEADER) {
    return { ok: false, reason: `卡要以「${SELF_HEADER}」开头` }
  }

  const p = cardPaths(root)
  let state
  let priorRaw
  try {
    ensureCard(root, { now: ts })
    state = readState(root) || ZERO_STATE(ts)
    priorRaw = readText(p.self) ?? `${SELF_HEADER}\n`
  } catch (e) {
    return { ok: false, reason: `卡目录开不了：${e?.message || e}` }
  }

  const body = selfBody(raw).trim()
  const fileText = body ? `${SELF_HEADER}\n\n${body}\n` : `${SELF_HEADER}\n`
  const rev = (Number(state.rev) || 0) + 1

  try {
    writeReadonly(p.self, fileText)
  } catch (e) {
    return { ok: false, reason: `写卡失败：${e?.message || e}` }
  }

  state.rev = rev
  state.digests['self.md'] = sha256(fileText)
  state.backup['self.md'] = fileText
  state.updatedAt = ts
  try {
    writeState(root, state)
  } catch (e) {
    return { ok: false, reason: `存不下状态：${e?.message || e}` }
  }

  try {
    await store?.append?.({
      type: 'card_patch',
      text: fileText.replace(/\s+$/, ''),
      refs: [],
      meta: { kind: 'self', target: null, decision: 'applied', dev: true, rev, from: priorRaw },
      source: 'owner',
      ts,
    })
  } catch (e) {
    log?.(`落 card_patch 失败：${e?.message || e}`)
  }

  try {
    writeProjection(root, { store, now: ts })
  } catch (e) {
    log?.(`刷新投影失败（卡本身已写好）：${e?.message || e}`)
  }

  return { ok: true, rev }
}

// ---------------------------------------------------------------- 篡改检查

/**
 * 摘要对不上就按 state.backup 改回去，并落一条 meta `card:tamper:<file>`。
 * 注意：这个函数是 async 的（要 metaSet），调用处必须 await——不 await 的话
 * 测试里立刻读 meta 会读不到（n9 的坑）。
 * @returns {{ok:boolean, restored:Array<{file:string, restored:boolean}>, checked:number}}
 */
export async function tamperCheck(root, { store, log } = {}) {
  const state = readState(root)
  const restored = []
  if (!state) return { ok: true, restored, checked: 0 }
  const recorded = Object.keys(state.digests || {})
  if (!recorded.length) return { ok: true, restored, checked: 0 }

  let ok = true
  const touch = (rel, detail) => {
    try {
      store?.metaSet?.(`card:tamper:${rel}`, JSON.stringify({ at: Date.now(), ...detail }))
    } catch (e) {
      log?.(`落 card:tamper 失败：${e?.message || e}`)
    }
  }

  for (const rel of [...new Set([...recorded, ...cardFileList(root)])]) {
    if (!Object.prototype.hasOwnProperty.call(state.digests, rel)) {
      // 摘要里没有、磁盘上却有 = 从外面塞进来的（bonds 里最常见）。
      if (rel.startsWith('bonds/')) {
        try {
          fs.rmSync(absOf(root, rel), { force: true })
          touch(rel, { restored: true, reason: '不在摘要里的文件' })
          log?.(`人设卡多出 ${rel}，已删掉`)
        } catch (e) {
          ok = false
          log?.(`删不掉多出来的 ${rel}：${e?.message || e}`)
        }
      }
      continue
    }
    const abs = absOf(root, rel)
    const raw = readText(abs)
    const digest = raw == null ? null : sha256(raw)
    if (digest === state.digests[rel]) continue
    const backup = state.backup?.[rel]
    if (typeof backup !== 'string') {
      ok = false
      log?.(`人设卡的 ${rel} 被改过，但没有备份，改不回去`)
      touch(rel, { restored: false, reason: '没有备份' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      writeReadonly(abs, backup)
      state.digests[rel] = sha256(backup)
      restored.push({ file: rel, restored: true })
      touch(rel, { restored: true, expected: state.digests[rel], actual: digest })
      log?.(`人设卡的 ${rel} 被外面改过，已改回去`)
    } catch (e) {
      ok = false
      restored.push({ file: rel, restored: false })
      touch(rel, { restored: false, reason: String(e?.message || e) })
      log?.(`改回 ${rel} 失败：${e?.message || e}`)
    }
  }

  if (restored.length) writeState(root, { ...state, updatedAt: Date.now() })
  return { ok, restored, checked: recorded.length }
}
