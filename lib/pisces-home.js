// 派希丝自己的家：第二个工作区 + 会话，只在她“一同成长=是”时建。
// 独立 home.json / 独立 cwd；主 home 不受影响。
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ensureHomeWithRetry } from './home.js'
import { attachToAgents } from './attach.js'
import { fixedPersonaFor } from './persona.js'
import { getCast } from './cast.js'
import { relationLines } from './relation.js'

export const PISCES_HOME_DIR = join('banks', 'pisces', 'home')
export const PISCES_HOME_FILE = join('banks', 'pisces', 'home.json')

export function piscesHomePaths(root) {
  const base = String(root ?? '')
  return {
    dir: join(base, PISCES_HOME_DIR),
    file: join(base, PISCES_HOME_FILE),
  }
}

export function readPiscesHome(root) {
  try {
    const j = JSON.parse(readFileSync(piscesHomePaths(root).file, 'utf8').replace(/^\uFEFF/, ''))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** cwd 在不在她自己的家（独立工作区）之下。两条 attach 判据共用这一份，别各写一套。 */
export function inPiscesHome(root, cwd) {
  const p = piscesHomePaths(root)
  const c = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const d = p.dir.replace(/\\/g, '/').replace(/\/+$/, '')
  return Boolean(c && d && (c === d || c.startsWith(`${d}/`)))
}

/**
 * 这条会话是不是派希丝单独家的那条：sessionId 等于 home.json 的，或 cwd 在她家目录下。
 * 第二库 attach 与 index 的 bankOf() 共用这一条判据（不复制）。
 * home 可以传 attach 手里那份（启动期 home.json 可能还没落盘），不传就现读。
 */
export function isPiscesHomeSession(root, { sessionId = '', cwd = '', home = null } = {}) {
  const h = home ?? readPiscesHome(root)
  const sid = String(h?.sessionId ?? '')
  if (sessionId && sid && String(sessionId) === sid) return true
  return inPiscesHome(root, cwd)
}

export async function ensurePiscesHome({
  ctx,
  root,
  log = () => {},
  retryMs,
  max,
  wait = null,
} = {}) {
  const p = piscesHomePaths(root)
  return ensureHomeWithRetry({
    ctx,
    root,
    name: '派希丝',
    dir: p.dir,
    file: p.file,
    titles: { workspace: '派希丝的家', session: '与派希丝单独聊天' },
    log,
    retryMs,
    max,
    wait,
  })
}

/**
 * 第二条 attach：只接派希丝家的会话，用固定人设 + 第二库。
 * 不接 roomRuntime；她单独聊时就是普通生成 + bank 落 heard/utterance。
 */
export function attachPiscesSolo({
  ctx,
  root,
  home,
  getBank,
  roomBack = null,
  config = {},
  log = () => {},
} = {}) {
  const shouldAttach = (agent) => {
    try {
      const cwd = agent?.cwd ?? agent?.ctx?.cwd ?? agent?.ctx?.session?.header?.cwd
      const asid = agent?.sessionId ?? agent?.ctx?.session?.id ?? agent?.ctx?.session?.header?.id
      return isPiscesHomeSession(root, { sessionId: String(asid ?? ''), cwd: String(cwd ?? ''), home })
    } catch {
      return false
    }
  }
  const isHerSession = (sessionId, key) => {
    try {
      if (isPiscesHomeSession(root, { sessionId: String(sessionId ?? ''), cwd: '', home })) return true
      if (key && String(key).startsWith('cwd:')) return inPiscesHome(root, String(key).slice(4))
      return false
    } catch {
      return false
    }
  }
  const sections = [{
    name: 'pisces:solo',
    order: 8500,
    text: [fixedPersonaFor(getCast()), relationLines({ demo: true })].join('\n\n'),
  }]
  return attachToAgents(ctx, {
    getStore: getBank,
    buildSections: () => ({ sections, lines: [], coldStart: false }),
    shouldAttach,
    isHerSession,
    roomBack: typeof roomBack === 'function' ? roomBack : null,
    config,
    log,
  })
}
