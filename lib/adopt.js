// 成年鱼（推广样本）：领养一条已经活过 90 天的鱼。
//
// 判断链只有一条（知识库 n26）：样本自己带一条 `type:'meta'`、`meta.kind:'demo'` 的事件；
// 领养 = 先查有没有起点（有就拒）→ `importSoulBundle` 原样搬（卡一起恢复）→ 返回后再读事件流
// 算 isDemo / demoName / demoLabel。**判定不看配置**：改 config 装不出这条鱼，
// 普通鱼也不会因为有人填了 demo 就多出两个特权动作。
import fs from 'node:fs'
import { importSoulBundle, readSoulBundle } from './export.js'
import { ADULT_LABEL, ADULT_NAME } from './teach.js'

export const ADULT_FORMAT = 'dsh-pisces/bundle'

const listOf = (events) => (Array.isArray(events) ? events : [])

/** 事件流里有没有 demo 标记。只认事件流，不看配置、不看文件名。 */
export function isDemo(events) {
  return listOf(events).some((e) => e && e.meta && e.meta.kind === 'demo')
}

const demoEvents = (events) => listOf(events).filter((e) => e && e.meta && e.meta.kind === 'demo')

// 旧样本里的那句已经取消（2026-11-12）。资产带哈希链，不能改正文；
// 读取时把旧 label 映射成新文案，样本资产与链保持原样。
const LEGACY_ADULT_LABEL = '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼'

/** demo 事件的 meta.label；旧样本没写、或还是旧那句，退回新文案。 */
export function demoLabel(events) {
  for (const e of demoEvents(events)) {
    const label = typeof e.meta.label === 'string' ? e.meta.label.trim() : ''
    if (label && label !== LEGACY_ADULT_LABEL) return label
  }
  return ADULT_LABEL
}

/** demo 事件的 meta.name；旧样本没写就退回固定名字派希丝。 */
export function demoName(events) {
  for (const e of demoEvents(events)) {
    const name = typeof e.meta.name === 'string' ? e.meta.name.trim() : ''
    if (name) return name
  }
  return ADULT_NAME
}

/**
 * 领养成年鱼。只在还没有起点时可用。
 * @returns {{ok:true, name:string, label:string, events:number, firstId:string|null, lastId:string|null, demo:boolean}
 *   | {ok:false, reason:string, problems?:string[]}}
 */
export async function adoptAdult({ root, store, file, now = Date.now() } = {}) {
  if (!store || typeof store.readAll !== 'function' || typeof store.append !== 'function') {
    return { ok: false, reason: '事件库还没准备好，领养不了' }
  }

  let events = []
  try {
    events = store.readAll() || []
  } catch (e) {
    return { ok: false, reason: `读事件流失败：${e?.message || e}` }
  }
  // 已经有起点就不给领养：她是谁只能定一次，老鱼不能靠这个换起点。
  if (events.some((e) => e && e.type === 'seed')) {
    return { ok: false, reason: '已经有起点了，不能再领养' }
  }

  if (!file || !fs.existsSync(String(file))) {
    return { ok: false, reason: '找不到成年鱼的数据包' }
  }

  // 先只核形状：不是本格式要明说；清单对不上交给 importSoulBundle 拒收。
  try {
    const doc = readSoulBundle(file)
    if (doc.format !== ADULT_FORMAT) {
      return { ok: false, reason: '不是这个项目的 soul bundle' }
    }
  } catch (e) {
    return { ok: false, reason: '不是这个项目的 soul bundle', problems: [String(e?.message || e)] }
  }

  const imported = await importSoulBundle({ file, store, root, now })
  if (!imported?.ok) {
    return {
      ok: false,
      reason: imported?.reason || '成年鱼的数据包没能搬进来',
      problems: Array.isArray(imported?.problems) ? imported.problems : [],
    }
  }

  let after = []
  try {
    after = store.readAll() || []
  } catch (e) {
    return { ok: false, reason: `读事件流失败：${e?.message || e}` }
  }

  return {
    ok: true,
    name: demoName(after),
    label: demoLabel(after),
    events: after.length,
    firstId: imported.firstId ?? null,
    lastId: imported.lastId ?? null,
    demo: isDemo(after),
  }
}
