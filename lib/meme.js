// 表情包（meme pack）：内置最小包 + 用户自己的包。
//
// 三条口径（2026-11-13 定，见知识库 n186）：
// 1. 只认「包」不认「插件」：一个目录 + pack.json，用户丢图进去就能用，不需要装第二个插件。
// 2. 内置包最小化：只放自绘占位图，素材由用户决定；发布包不装用户包。
// 3. 选图不调模型：用 mood/最近使用/强度做纯规则挑选；挑不到就不发，不拿最近的凑。
//
// 这个文件只做文件与挑选，不碰 ctx、不发请求；路径安全（不许 ..、不许绝对路径）在这里兜住。
import fs from 'node:fs'
import path from 'node:path'

/** 允许的情绪标签。用户包可以只用其中几个；未知标签会被忽略而不是报错。 */
export const MEME_MOODS = ['happy', 'laugh', 'flat', 'hmm', 'annoyed', 'shy', 'tired', 'serious']

/** 单张图上限：2MB。超过就不收，避免用户把大图塞进包。 */
export const MEME_MAX_BYTES = 2 * 1024 * 1024
/** 一个包最多多少条。 */
export const MEME_MAX_ENTRIES = 200

const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/
const FILE_RE = /^[^\\/:*?"<>|]+\.(png|jpe?g|webp|gif)$/i
const TYPE_OF = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const intIn = (v, lo, hi, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/** 按扩展名给 Content-Type；不认识的返回 null。 */
export function imageType(file) {
  return TYPE_OF[path.extname(String(file || '')).toLowerCase()] || null
}

/**
 * 读一个包目录。坏条目跳过并计数，坏包返回 {ok:false}，不抛。
 * @param {string} dir 包目录（含 pack.json）
 * @param {'builtin'|'user'} source
 */
export function parsePack(dir, source = 'user') {
  const base = path.resolve(dir)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(base, 'pack.json'), 'utf8'))
  } catch (e) {
    return { ok: false, reason: `读不到 pack.json：${e?.message || e}` }
  }
  const name = str(raw?.name) || path.basename(base)
  if (!ID_RE.test(name)) return { ok: false, reason: `包名不合法：${name}` }
  const list = Array.isArray(raw?.entries) ? raw.entries : []
  if (list.length === 0) return { ok: false, reason: '包里没有 entries' }
  const entries = []
  const seen = new Set()
  let skipped = 0
  for (const item of list.slice(0, MEME_MAX_ENTRIES)) {
    const id = str(item?.id)
    const file = str(item?.file)
    if (!ID_RE.test(id) || seen.has(id)) {
      skipped += 1
      continue
    }
    if (!FILE_RE.test(file) || path.basename(file) !== file) {
      skipped += 1
      continue
    }
    const abs = path.join(base, file)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      skipped += 1
      continue
    }
    if (!st.isFile() || st.size === 0 || st.size > MEME_MAX_BYTES || !imageType(file)) {
      skipped += 1
      continue
    }
    const moods = (Array.isArray(item?.mood) ? item.mood : [])
      .map((m) => str(m).toLowerCase())
      .filter((m) => MEME_MOODS.includes(m))
    seen.add(id)
    entries.push({
      id,
      file,
      abs,
      mood: [...new Set(moods)],
      intensity: intIn(item?.intensity, 1, 3, 2),
      text: str(item?.text).slice(0, 80),
    })
  }
  if (entries.length === 0) return { ok: false, reason: '包里的条目都不可用' }
  return {
    ok: true,
    pack: {
      name,
      title: str(raw?.title) || name,
      version: str(raw?.version) || '0.0.0',
      source,
      dir: base,
      entries,
      skipped,
    },
  }
}

/**
 * 扫目录拿包：`builtinDir` 一个包，`userDir` 下每个子目录一个包。
 * 坏的跳过，不抛；同名包用户覆盖内置。
 */
export function discoverPacks({ builtinDir, userDir } = {}) {
  const packs = []
  if (builtinDir) {
    const r = parsePack(builtinDir, 'builtin')
    if (r.ok) packs.push(r.pack)
  }
  let names = []
  if (userDir) {
    try {
      names = fs.readdirSync(userDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch {
      names = []
    }
  }
  const byName = new Map(packs.map((p) => [p.name, p]))
  for (const name of names) {
    const r = parsePack(path.join(userDir, name), 'user')
    if (r.ok) byName.set(r.pack.name, r.pack)
  }
  return [...byName.values()]
}

/** 扁平化所有条目，供挑选与面板计数。 */
export function allEntries(packs) {
  const out = []
  for (const p of packs) for (const e of p.entries) out.push({ pack: p.name, source: p.source, ...e })
  return out
}

/**
 * 挑一张。不调模型，纯规则：
 * - 有 mood 就优先同 mood；没有或挑不到就退回全部。
 * - 最近用过的（recent：id 数组，按时间新→旧）先排除；全被排除就返回 null（宁可不发）。
 * - 同分随机；`rand` 可注入便于测试。
 * @returns {object|null} { pack, id, file, abs, mood, intensity, text, url }
 */
export function pickMeme(packs, { mood, recent = [], rand = Math.random, pack } = {}) {
  const recentSet = new Set((Array.isArray(recent) ? recent : []).map(String))
  const pool = allEntries(packs).filter((e) => !pack || e.pack === pack)
  if (pool.length === 0) return null
  const wanted = str(mood).toLowerCase()
  const byMood = wanted ? pool.filter((e) => e.mood.includes(wanted)) : []
  const tiers = [byMood, pool]
  for (const tier of tiers) {
    if (tier.length === 0) continue
    // 最近用过的先排除；如果一个可用的都没有，就退回空——宁可不发，也不重发上一张。
    const use = tier.filter((e) => !recentSet.has(e.id))
    if (use.length === 0) continue
    // 在同一个包里挑，避免一次回复串包；包内按强度高的略优先（1–3，权重 1/2/3）。
    const weights = use.map((e) => intIn(e.intensity, 1, 3, 2))
    const total = weights.reduce((a, b) => a + b, 0)
    let t = Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * total
    let i = 0
    for (; i < use.length; i += 1) {
      t -= weights[i]
      if (t < 0) break
    }
    const hit = use[Math.min(i, use.length - 1)]
    return { ...hit, url: memeUrl(hit.pack, hit.id) }
  }
  return null
}

/** 给客户端的相对 URL（同源，不走外网）。 */
export function memeUrl(pack, id) {
  return `/dsh-pisces-api/meme/${encodeURIComponent(pack)}/${encodeURIComponent(id)}.png`
}

/**
 * 路由用：把 (pack, id) 解析成可读文件。任何越界/不存在都返回 null。
 * @returns {{file:string,type:string}|null}
 */
export function resolveMemeFile(packs, packName, id) {
  const name = str(packName)
  const key = str(id)
  if (!ID_RE.test(name) || !ID_RE.test(key)) return null
  const pack = (packs || []).find((p) => p.name === name)
  if (!pack) return null
  const entry = pack.entries.find((e) => e.id === key)
  if (!entry) return null
  const abs = path.resolve(entry.abs)
  const root = path.resolve(pack.dir) + path.sep
  if (!abs.startsWith(root)) return null
  try {
    if (!fs.statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return { file: abs, type: imageType(abs) }
}

/** 面板/状态用：只给计数与包名，不给图片内容。 */
export function packSummary(packs) {
  return (packs || []).map((p) => ({
    name: p.name,
    title: p.title,
    source: p.source,
    entries: p.entries.length,
  }))
}
