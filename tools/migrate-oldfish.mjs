// 一次性迁移：清掉成年鱼样本（前 90 天假数据），把旧鱼的 soul bundle 接进来，再把真实对话接回。
//
// 口径：
// 1. 真实对话 = source 不是 system 的事件（owner/agent/tool），原样保留。
// 2. 样本 = source === 'system' 的 96 条成年鱼种子，整批清掉。
// 3. 旧鱼 bundle 先导入（空库），再追加真实对话，保证事件流按时间顺序。
// 4. 不恢复旧鱼的卡（派希丝的人设与卡保留）；日记合并。
// 5. 结束后重建检索索引并校验整条 hash 链。
//
// 注意：真机宿主可能正开着 events.db，不能删文件；这里用 DELETE FROM events 就地清空。
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../lib/store.js'
import { importSoulBundle } from '../lib/export.js'
import { rebuildIndex } from '../lib/search.js'

const ROOT = process.env.PISCES_ROOT || 'G:/DS工作区/pisces-home/data'
const BUNDLE = 'G:/DS工作区/dsh-pisces/exports/soul-2026-11-09-2215.soul.json'

const j = (v, d) => {
  try {
    return typeof v === 'string' ? JSON.parse(v) : v ?? d
  } catch {
    return d
  }
}
const pick = (e) => ({
  id: e.id,
  ts: Number(e.ts),
  day: e.day,
  type: e.type,
  text: e.text,
  refs: j(e.refs, []),
  meta: j(e.meta, {}),
  confidence: e.confidence,
  source: e.source,
})

let store = await createStore({ root: ROOT })
const before = store.count()
const all = store.readAll()
const real = all.filter((e) => e.source !== 'system').map(pick).sort((a, b) => a.ts - b.ts)
const seed = all.filter((e) => e.source === 'system')
const diary = store.diaryAll()
console.log('before', before, 'real', real.length, 'seed', seed.length, 'diary', diary.length)
store.close()

const db = new DatabaseSync(path.join(ROOT, 'events.db'))
db.exec('PRAGMA busy_timeout = 8000')
db.exec('DELETE FROM events')
db.exec("DELETE FROM sqlite_sequence WHERE name = 'events'")
db.close()
console.log('events cleared')

store = await createStore({ root: ROOT })
console.log('fresh count', store.count())

const imp = await importSoulBundle({ file: BUNDLE, store })
console.log('bundle', JSON.stringify({ ok: imp.ok, read: imp.read, imported: imp.imported, skipped: imp.skipped, failed: imp.failed, diary: imp.diary, chain: imp.chain }))

for (const e of real) {
  if (store.readAll().some((x) => x.id === e.id)) continue
  await store.append(e)
}
if (diary.length) store.diaryPut(diary)

const rebuilt = rebuildIndex(store, { log: console.log })
const stats = store.indexStats()
const v = store.verify()
console.log('after count', store.count(), 'index', JSON.stringify(stats), 'rebuild', JSON.stringify(rebuilt))
console.log('verify', JSON.stringify(v))
const rows = store.readAll()
console.log('first', rows[0]?.id, rows[0]?.day, rows[0]?.type, rows[0]?.source)
console.log('last', rows[rows.length - 1]?.id, rows[rows.length - 1]?.day, rows[rows.length - 1]?.type, rows[rows.length - 1]?.source)
const bySource = {}
for (const e of rows) bySource[e.source] = (bySource[e.source] || 0) + 1
console.log('bySource', JSON.stringify(bySource))
store.close()
