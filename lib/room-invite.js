// 客厅邀请码（2026-11-14）：把客厅那几轮记录搬进某条鱼自己的库，必须是**人手动**取一次码、
// 去她的家会话里贴一次——刻意留一道手。
//
// 为什么不自动吸：
// - 「客厅是客厅、家是家」是产品口径（n192）；自动同步等于两处事件流同时长、天平会偏；
// - 麻烦本身就是提醒：跨场景不是免费的，你要真想让她们记得，才付这一步。
//
// 码是**一次性**的：贴出即认（与开发者钥匙同一套姿势，n65），15 分钟过期，用过就作废。
// 只存在 <root>/room/invites.json；不进提示词、不进发布包。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const INVITE_FILE = 'invites.json'
export const INVITE_TTL_MS = 15 * 60 * 1000
const INVITE_MAX = 12
// 去掉 I/O/0/1：手抄、口述都不容易错。
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6

function fileOf(root) {
  return join(String(root ?? ''), 'room', INVITE_FILE)
}

/** 读全部邀请码；坏文件当空表，不抛。 */
export function readInvites(root) {
  try {
    const list = JSON.parse(readFileSync(fileOf(root), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeInvites(root, list) {
  try {
    mkdirSync(join(String(root ?? ''), 'room'), { recursive: true })
    writeFileSync(fileOf(root), `${JSON.stringify(list.slice(0, INVITE_MAX))}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 未过期、没用过的码（给观测台/state 看）。 */
export function pendingInvites(root, { now = Date.now() } = {}) {
  return readInvites(root).filter((x) => !x.used && Number(x.expiresAt) > now)
}

function randomCode(rnd) {
  let out = ''
  for (let i = 0; i < CODE_LEN; i++) {
    const n = Math.floor(Number(rnd()) * ALPHABET.length)
    out += ALPHABET[Math.min(ALPHABET.length - 1, Math.max(0, n))]
  }
  return out
}

/**
 * 生成一个邀请码。同角色旧的未用码会被清掉（一次只留有效的一张），
 * 别的角色的码保留——所以鲸歌、派希丝可以各有一张同时挂着。
 * @returns {{code:string, role:string, createdAt:number, expiresAt:number, used:boolean} | null}
 */
export function createInvite(root, { role = 'any', now = Date.now(), ttlMs = INVITE_TTL_MS, rnd = Math.random } = {}) {
  const alive = pendingInvites(root, { now })
  let code = randomCode(rnd)
  let guard = 0
  while (alive.some((x) => x.code === code) && guard++ < 20) code = randomCode(rnd)
  const invite = {
    code,
    role: String(role || 'any'),
    createdAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || INVITE_TTL_MS),
    used: false,
  }
  // 只留这一张 + 别的角色还没用的 + 最近用过的（做回执用）。
  const keep = alive.filter((x) => x.role !== invite.role)
  const used = readInvites(root).filter((x) => x.used).slice(0, 3)
  writeInvites(root, [invite, ...keep, ...used])
  return invite
}

/** 一次给两条鱼各生成一张（鲸歌的、派希丝的），互不覆盖。 */
export function createInvitePair(root, opts = {}) {
  return {
    ordinary: createInvite(root, { ...opts, role: 'ordinary' }),
    adult: createInvite(root, { ...opts, role: 'adult' }),
  }
}

/**
 * 在一条用户消息里找邀请码：贴出即认，认过就作废。
 * role 给了就只认那个角色的码（鲸歌的家只认 ordinary，派希丝的家只认 adult）。
 * @returns {{code:string, role:string, usedAt:number} | null}
 */
export function consumeInvite(root, text, { now = Date.now(), role = null } = {}) {
  const hay = String(text ?? '').toUpperCase()
  if (!hay) return null
  const list = readInvites(root)
  for (let i = 0; i < list.length; i++) {
    const inv = list[i]
    if (!inv || inv.used) continue
    if (Number(inv.expiresAt) <= now) continue
    const want = String(inv.role || 'any')
    if (role && want !== 'any' && want !== role) continue
    if (!hay.includes(String(inv.code))) continue
    const used = { ...inv, used: true, usedAt: now }
    list[i] = used
    writeInvites(root, list)
    return { code: used.code, role: want, usedAt: now }
  }
  return null
}

/** 收下邀请码后注入给她的那一句：只讲"发生了什么"，不让她念出来。 */
export const ROOM_INVITE_LINE = '[客厅记录] 你刚把客厅最近的记录收进了自己的库。往后聊到那里的事，就按自己记得的说；这句不用念出来。'

// ---------------------------------------------------------------------------
// 客厅门票（2026-11-14）：去客厅要通行码，回来不用码（在各自家说一声就行）。
// 通行码贴进客厅 → 门票开 90 分钟；家里说「<名字>，从客厅回来」→ 吸收 + 关门。
// ---------------------------------------------------------------------------

export const TICKET_FILE = 'ticket.json'
export const TICKET_MS = 90 * 60 * 1000

function ticketFile(root) {
  return join(String(root ?? ''), 'room', TICKET_FILE)
}

/** 门票还开着就回到期时间，过期/没开回 null。 */
export function readTicket(root, { now = Date.now() } = {}) {
  try {
    const t = JSON.parse(readFileSync(ticketFile(root), 'utf8'))
    const exp = Number(t && t.expiresAt)
    return Number.isFinite(exp) && exp > now ? exp : null
  } catch {
    return null
  }
}

/** 开门：贴码之后调用。 */
export function openTicket(root, { now = Date.now(), ms = TICKET_MS } = {}) {
  try {
    mkdirSync(join(String(root ?? ''), 'room'), { recursive: true })
    writeFileSync(ticketFile(root), JSON.stringify({ openedAt: now, expiresAt: now + Math.max(1000, ms) }), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 面板用：门开没开、到几点、**上次谁回来过**（关门后仍保留 backed，方便事后看）。
 *  2026-11-14 定：回家的回执只放面板，不往她嘴里塞字（她对自己说的话很敏感）。 */
export function readTicketInfo(root, { now = Date.now() } = {}) {
  try {
    const t = JSON.parse(readFileSync(ticketFile(root), 'utf8'))
    const exp = Number(t && t.expiresAt)
    const open = Number.isFinite(exp) && exp > now
    const b = { ordinary: false, adult: false, ...(t && t.backed) }
    return {
      open,
      until: open ? exp : 0,
      backed: { ordinary: Boolean(b.ordinary), adult: Boolean(b.adult) },
    }
  } catch {
    return { open: false, until: 0, backed: { ordinary: false, adult: false } }
  }
}

/** 关门：两只都回来了才关（各自会话分开说，中间有时间差）。 */
export function closeTicket(root) {
  try {
    writeFileSync(ticketFile(root), JSON.stringify({ openedAt: 0, expiresAt: 0 }), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 记一次「我回来了」。两只各说各的，中间隔多久都行：
 * 只记自己那一格，**两只都回来才关门**；门已经过期就当没开。
 * @returns {{closed:boolean, both:boolean, backed?:object}}
 */
export function markBack(root, role, { now = Date.now() } = {}) {
  try {
    const t = JSON.parse(readFileSync(ticketFile(root), 'utf8'))
    const exp = Number(t && t.expiresAt)
    if (!Number.isFinite(exp) || exp <= now) return { closed: false, both: false }
    const backed = { ordinary: false, adult: false, ...(t && t.backed) }
    if (role === 'ordinary' || role === 'adult') backed[role] = true
    const both = Boolean(backed.ordinary && backed.adult)
    writeFileSync(
      ticketFile(root),
      JSON.stringify({ openedAt: Number(t.openedAt) || 0, expiresAt: both ? 0 : exp, backed }),
      'utf8',
    )
    return { closed: both, both, backed }
  } catch {
    return { closed: false, both: false }
  }
}

/**
 * 回家的口令：**整句匹配**，不做子串判断（2026-11-14 改）。
 *
 * 旧口径是 `/(我)?回来了|到家了|回客厅了/` 的子串匹配，两个毛病：
 * 1. 任何含「回来了」的话都算回家——测试里甚至断言过「他回来了吗」= true，
 *    真机上鲸歌好几次把一句普通聊天当成回家口令；
 * 2. 「回客厅了」被算成回家，语义正好相反（那是**去**客厅）。
 *
 * 现在只认：去掉空白/标点后**整句等于**下列之一。主人习惯用要求句式，
 * 所以额外认「<名字>，从客厅回来（吧）」，名字可省。
 */
const BACK_EXACT = new Set(['我回来了', '回来了', '到家了', '我到家了', '回家了', '我回家了'])
const BACK_ROOM_RE = /^(鲸歌|鲸漪|姐姐|妹妹)?从客厅回来(吧|了)?$/
const BACK_PUNCT_RE = /[\s\u3000，,。.！!？?、；;：:…~～—\-_（）()【】[\]"'“”‘’]/g

/** 只用来比对的规范化：去空白与标点，不改原话。 */
export function normalizeBackText(text) {
  return String(text ?? '').replace(BACK_PUNCT_RE, '')
}

export function isBackText(text) {
  const s = normalizeBackText(text)
  if (!s || s.length > 12) return false
  return BACK_EXACT.has(s) || BACK_ROOM_RE.test(s)
}

/** 回家回执的那句话（2026-11-14 定案：**只在面板显示**，不进聊天、不逼她说）。
 *  留这个常量是为了面板/文档共用同一句，别再往 llm/stream 里塞。 */
export const ROOM_BACK_RECEIPT = '门记下了，你回来了。'

/** 「回来了」之后注入给她的一句：只讲发生了什么，**不要求她念任何话**
 *  （2026-11-14 三次尝试后定案：回执只放面板，见 n202）。 */
export const ROOM_BACK_LINE = '[客厅记录] 你刚从客厅回来，那段话已经收进你的库了。按自己记得的说就行；这句不用念出来。'

/** 没门票时客厅回的那一句（不落库）。 */
export const ROOM_LOCKED_LINE = '客厅还没开门。去设置里取一张通行码，贴到这里再进。'

