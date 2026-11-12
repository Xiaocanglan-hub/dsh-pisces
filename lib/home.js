// home.js —— 她的家：一个工作区 + 一条对话会话（领养之后自动出现在侧栏）。
//
// 口径照 dsh-fish 的 lib/home.js（宿主签名已核实，注释见那边开头）：
//   ctx.get('workspaceRegistry') → .list() / .create(path, title) / .get(id)
//     - create 的语义：同一个规范路径重复调用返回**已存在**那条，不新建、**不改标题**。
//   ctx.get('sessionController') → .create({ workspaceId }) → { sessionId }
//     - 传 workspaceId 才会挂进工作区（侧栏才看得见）；.rename({ sessionId, title }) 需要
//       宿主的 sessionTitle 服务，没有就跳过（不是致命错误）。
//
// 幂等（关键，否则每次重启都多一条会话）：
//   {wsId, sessionId, name, at} 记在 `<root>/home.json`。下次先验「这个 sessionId 还在不在
//   这个工作区的 sessionIds 里」，不在就重建；用户可能把会话归档/删了，不能永远指向空壳。
//
// 宿主是**异步索引**的（dsh-fish 的实测坑）：刚建好的会话短时间内不在 ws.sessionIds 里。
// 所以「查不到」不能立刻当成没了 —— createdAt 距今不到 HOME_GRACE_MS 就先当它还活着，
// 否则「刚建好 → 下次启动查不到 → 又建一条」，几轮下来同一间屋堆出一串空壳会话。
//
// 这个模块只做「建一次、之后复用」这一层：轮换、唤醒、归档策略都不在这里。
import fs from 'node:fs'
import { join } from 'node:path'

export const TITLE_WORKSPACE = '肥鱼的家'
export const TITLE_SESSION = '与肥鱼聊天'

/** 刚建出来的会话，宿主索引还没跟上也算活着（见文件头）。 */
export const HOME_GRACE_MS = 60_000

export const HOME_FILE = 'home.json'

/**
 * 等工作区服务的时间口径：宿主把 `@deepseek-ai/dsh-workspace` 注册得比插件晚，
 * `ready` 完成时当场 `ctx.get('workspaceRegistry')` 拿到 null 是常态，不是「没有」。
 * 默认 1s × 20 次（约 20s 窗口），可用 config.home.retryMs / config.home.max 覆盖。
 */
export const HOME_RETRY_MS = 1000
export const HOME_RETRY_MAX = 20

/** 名字 → 两个标题。没名字（普通鱼 / 还没领养）退回「肥鱼」。 */
export function homeTitles(name) {
  const n = String(name ?? '').trim()
  if (!n) return { workspace: TITLE_WORKSPACE, session: TITLE_SESSION }
  return { workspace: `${n}的家`, session: `与${n}聊天` }
}

/** 宿主服务一律这样取：get 可能抛、可能不存在。 */
function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get !== 'function') return null
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

/** 坏文件、没权限、不是对象：都当空档子（不能因为一份坏 json 让家建不出来）。 */
function readHome(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** tmp → rename（Windows 上被占用时 rename 会失败，退化成直接写）；失败只回 false，不抛。 */
function writeHome(file, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 没有 tmp 可清就算了 */
    }
    try {
      fs.writeFileSync(file, text, 'utf8')
      return true
    } catch {
      return false
    }
  }
}

/** createdAt 距今不到宽限期（时钟偏一点也认，别因为 now 早几毫秒就判死）。 */
function withinGrace(saved, now) {
  const t = Date.parse(String(saved?.createdAt ?? ''))
  if (!Number.isFinite(t)) return false
  const dt = Number(now) - t
  return dt < HOME_GRACE_MS && dt > -HOME_GRACE_MS
}

/**
 * 改工作区标题。`create` 不碰已存在那条的标题，所以复用这条路径才需要单独改一次。
 *
 * 宿主真正的改名入口在**实体**上（`registry.get(id)` 返回的 Workspace 有 `setTitle`），
 * registry 自己早先没有 update/rename；这里按 setTitle → reg.rename → reg.update 依次试，
 * 一个都不行就 log 一行「宿主不支持」，**不失败**——屋子还能住，只是侧栏名不对。
 */
async function fixWorkspaceTitle(reg, ws, wsId, title, log) {
  if (String(ws?.title ?? '') === title) return true
  try {
    if (typeof ws?.setTitle === 'function') {
      await ws.setTitle(title)
      return true
    }
    if (typeof reg?.rename === 'function') {
      await reg.rename(wsId, title)
      return true
    }
    if (typeof reg?.update === 'function') {
      await reg.update(wsId, { title })
      return true
    }
  } catch {
    /* 宿主拒了：不致命，下面只记一行 */
  }
  log(`工作区标题没改（宿主不支持）：现在是「${String(ws?.title ?? '')}」，期望「${title}」`)
  return false
}

/**
 * 把家建好（或复用）。**永不抛**：启动链路上抛异常会带走插件树。
 *
 * @returns {Promise<{ok:true, wsId:string, sessionId:string, workspaceTitle:string,
 *   sessionTitle:string, created:{workspace:boolean, session:boolean}, dir:string}
 *   | {ok:false, reason:string}>}
 */
export async function ensureHome({ ctx, root, name = null, log = () => {}, now = Date.now(), dir: dirOpt = null, file: fileOpt = null, titles: titlesOpt = null } = {}) {
  const reg = serviceOf(ctx, 'workspaceRegistry')
  if (!reg || typeof reg.create !== 'function') {
    // 服务缺失是**可重试**的：宿主可能只是晚注册（n55）。
    return { ok: false, reason: '宿主没有 workspaceRegistry 服务', retryable: true }
  }
  const base = String(root ?? '').trim()
  if (!base) return { ok: false, reason: '没有数据根，建不了家' }

  const clock = Number(now) || Date.now()
  const at = new Date(clock).toISOString()
  const dir = dirOpt ? String(dirOpt) : join(base, 'home')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: `家目录建不出来：${String(e?.message ?? e).slice(0, 120)}` }
  }

  const file = fileOpt ? String(fileOpt) : join(base, HOME_FILE)
  const saved = readHome(file)
  const titles = titlesOpt && typeof titlesOpt === 'object'
    ? { workspace: String(titlesOpt.workspace || TITLE_WORKSPACE), session: String(titlesOpt.session || TITLE_SESSION) }
    : homeTitles(name)
  const fishName = String(name ?? '').trim() || null

  // ---- 工作区：记着的 wsId 还在就复用，否则让宿主建（同路径重复 create 会返回已存在那条） ----
  let ws = null
  let wsExisted = false
  if (saved.wsId) {
    try {
      ws = reg.get(String(saved.wsId)) ?? null
      wsExisted = Boolean(ws)
    } catch {
      ws = null
    }
  }
  if (!ws) {
    try {
      ws = await reg.create(dir, titles.workspace)
    } catch (e) {
      return { ok: false, reason: `建工作区失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
  }
  const wsId = String(ws?.id ?? ws?.workspaceId ?? '')
  if (!wsId) return { ok: false, reason: '宿主返回的工作区没有 id' }
  await fixWorkspaceTitle(reg, ws, wsId, titles.workspace, log)

  // ---- 会话 ----
  const sc = serviceOf(ctx, 'sessionController')
  if (!sc || typeof sc.create !== 'function') {
    // 工作区已经建好了，先把 wsId 记下来，下次换个宿主版本就能接上。
    writeHome(file, { ...saved, wsId, name: fishName, at })
    // 同样是「服务晚就绪」：可重试。
    return { ok: false, reason: '宿主没有 sessionController 服务', retryable: true }
  }

  const savedSession = String(saved.sessionId ?? '')
  let reuse = false
  if (savedSession) {
    let listed = false
    try {
      const cur = reg.get(wsId)
      const ids = Array.isArray(cur?.sessionIds) ? cur.sessionIds.map((x) => String(x)) : []
      listed = ids.includes(savedSession)
    } catch {
      listed = false
    }
    // 索引还没跟上（刚建出来）就先当活着；宽限期过了还查不到才重建。
    reuse = listed || withinGrace(saved, clock)
  }

  let sessionId = reuse ? savedSession : ''
  let createdSession = false
  if (!reuse) {
    let created
    try {
      created = await sc.create({ workspaceId: wsId })
    } catch (e) {
      return { ok: false, reason: `建会话失败：${String(e?.message ?? e).slice(0, 120)}` }
    }
    sessionId = String(created?.sessionId ?? created?.id ?? '')
    if (!sessionId) return { ok: false, reason: '宿主建了会话但没给 id' }
    createdSession = true
    if (typeof sc.rename === 'function') {
      // 命名失败不影响功能：侧栏会显示默认标题，但会话本身是好的。
      try {
        await sc.rename({ sessionId, title: titles.session })
      } catch {
        /* 改不了就保持默认标题 */
      }
    }
  } else if (String(saved.sessionTitle ?? '') !== titles.session && typeof sc.rename === 'function') {
    // 名字从「没名字」变成「派希丝」：会话跟着改一次名，之后不再调（sessionTitle 记进 home.json）。
    try {
      await sc.rename({ sessionId, title: titles.session })
    } catch {
      /* 宿主拒了就算了 */
    }
  }

  const next = {
    // 保持已有字段（别的模块以后要往这份档里加东西的话，别被这里抹掉）。
    ...saved,
    wsId,
    sessionId,
    name: fishName,
    at,
    workspaceTitle: titles.workspace,
    sessionTitle: titles.session,
  }
  // createdAt 只在真正新建会话时刷新：它是宽限期的起点，复用时借别人的时间戳会让宽限期失效。
  if (createdSession) next.createdAt = at
  writeHome(file, next)

  const created = { workspace: !wsExisted, session: createdSession }
  if (created.workspace || created.session) {
    log(`家：${created.workspace ? '新建' : '复用'}工作区 · ${created.session ? '新建' : '复用'}会话`)
  }
  return {
    ok: true,
    wsId,
    sessionId,
    workspaceTitle: titles.workspace,
    sessionTitle: titles.session,
    created,
    dir,
  }
}

/**
 * 带重试的建家：宿主的 workspaceRegistry / sessionController 常比插件晚注册，
 * `ready` 完成时 `ctx.get` 拿到 null 就一次放弃，侧栏就永远不会有「派希丝的家」（n47 同类坑）。
 *
 * 只重试 `retryable:true` 的失败（服务缺失）；目录写不进去、建工作区失败这类不重试——
 * 等再久也不会好，只会把日志刷满。
 *
 * `wait` 可注入（测试用），默认真等 `retryMs`；超次数返回最后一次失败，
 * reason 后面加「（重试 N 次仍没有）」。
 */
export async function ensureHomeWithRetry({
  ctx,
  root,
  name = null,
  log = () => {},
  now,
  retryMs = HOME_RETRY_MS,
  max = HOME_RETRY_MAX,
  wait = null,
  dir = null,
  file = null,
  titles = null,
} = {}) {
  const ms = Number(retryMs)
  const step = Number.isFinite(ms) && ms >= 0 ? ms : HOME_RETRY_MS
  const cap = Math.floor(Number(max))
  const tries = Number.isFinite(cap) && cap >= 0 ? cap : HOME_RETRY_MAX
  const sleep = typeof wait === 'function' ? wait : (delay) => new Promise((r) => setTimeout(r, delay))

  let r = await ensureHome({ ctx, root, name, log, now, dir, file, titles })
  let n = 0
  while (r?.ok !== true && r?.retryable === true && n < tries) {
    n += 1
    log(`家：等工作区服务（第 ${n} 次）`)
    await sleep(step)
    r = await ensureHome({ ctx, root, name, log, now, dir, file, titles })
  }
  if (r?.ok !== true && r?.retryable === true && n > 0) {
    return { ...r, reason: `${String(r.reason ?? '原因不明')}（重试 ${n} 次仍没有）` }
  }
  return r
}
