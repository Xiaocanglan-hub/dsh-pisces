// 客厅自己的家：第三个工作区 + 会话。
// 鲸歌的家 / 派希丝的家 / 客厅 三个入口；客厅会话里只有客厅轮次，不混私聊。
// 只在 setup.room === true 时建；幂等，文件在 <root>/room/home.json。
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { ensureHomeWithRetry } from './home.js'

export const ROOM_HOME_DIR = join('room', 'home')
export const ROOM_HOME_FILE = join('room', 'home.json')

export function roomHomePaths(root) {
  const base = String(root ?? '')
  return {
    dir: join(base, ROOM_HOME_DIR),
    file: join(base, ROOM_HOME_FILE),
  }
}

export function readRoomHome(root) {
  try {
    const j = JSON.parse(readFileSync(roomHomePaths(root).file, 'utf8').replace(/^\uFEFF/, ''))
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

export async function ensureRoomHome({ ctx, root, log = () => {}, retryMs, max, wait = null } = {}) {
  const p = roomHomePaths(root)
  // 先落一份带 workspacePath 的占位档：ensureHome 建会话时会触发 agent/created，
  // attach 的 shouldAttach 只认 cwd，占位档能让它当场认出客厅（否则要等下一次重启）。
  if (!existsSync(p.file)) {
    try {
      mkdirSync(p.dir, { recursive: true })
      const at = new Date().toISOString()
      writeFileSync(p.file, `${JSON.stringify({
        name: '客厅',
        workspaceTitle: '客厅',
        sessionTitle: '鱼肥生双的客厅',
        workspacePath: p.dir,
        at,
        createdAt: at,
      }, null, 2)}\n`, 'utf8')
    } catch {
      /* 占位失败：ensureHome 自己还会试 */
    }
  }
  return ensureHomeWithRetry({
    ctx,
    root,
    name: '客厅',
    dir: p.dir,
    file: p.file,
    titles: { workspace: '客厅', session: '鱼肥生双的客厅' },
    log,
    retryMs,
    max,
    wait,
  })
}
