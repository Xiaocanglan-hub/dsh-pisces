// tools/rebuild-card.mjs 与 tools/revive.mjs：从事件流重建卡、把 soul bundle 复活到新目录。
// 注意：这个文件测的是 tools/ 下的脚本；lib/tools.js（工具面）在 test/tools.test.mjs。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createStore } from '../lib/store.js'
import { cardPaths, readCard, restoreCard, writeProjection } from '../lib/card.js'
import { exportSoulBundle } from '../lib/export.js'
import { rebuildCardFromEvents } from '../tools/rebuild-card.mjs'
import { revive } from '../tools/revive.mjs'

const NOW = Date.parse('2026-11-10T01:00:00+08:00')
const DAY = 86_400_000
const HOUR = 3_600_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_REVIVE = path.resolve(HERE, '../tools/revive.mjs')

const tmp = (tag) => mkdtempSync(path.join(tmpdir(), `pisces-${tag}-`))
const writable = (file) => (statSync(file).mode & 0o222) !== 0

const SELF_TEXT = '我是一条会长的鱼。\n我答应之前会先停一下。'
const BOND_TEXT = '他会回来的。'

/** 一个带两条 applied card_patch（self + bond）的小库。 */
async function storeWithPatches() {
  const root = tmp('rebuild-card')
  const store = await createStore({ root, forceJsonl: true })
  await store.append({
    type: 'card_patch',
    ts: NOW - 2 * HOUR,
    text: SELF_TEXT,
    refs: ['ev_src_self'],
    meta: { kind: 'self', target: null, decision: 'applied', rev: 1, from: '' },
    source: 'tool',
  })
  await store.append({
    type: 'card_patch',
    ts: NOW - HOUR,
    text: BOND_TEXT,
    refs: ['ev_src_bond'],
    meta: { kind: 'bond', target: '他', decision: 'applied', rev: 2, from: '' },
    source: 'tool',
  })
  return { root, store }
}

/** 用 export.js 造一个真 bundle（seed + 一句原话 + 两篇日记（含 day 0）+ 卡）。 */
async function makeBundle() {
  const dir = tmp('revive-fixture')
  const srcRoot = path.join(dir, 'src')
  mkdirSync(srcRoot, { recursive: true })
  const store = await createStore({ root: srcRoot, forceJsonl: true })
  await store.append({ type: 'seed', ts: NOW - 3 * DAY, text: '你不是助手。你刚开始存在。', source: 'system' })
  await store.append({ type: 'utterance', ts: NOW - 2 * DAY, text: '叫我阿岚。', source: 'tool' })
  store.diaryPut([
    { day: '2026-11-08', text: '第一篇日记。', at: NOW - 2 * DAY },
    { day: 0, text: 'day 0 那篇也要保住。', at: NOW - DAY },
  ])
  restoreCard(
    srcRoot,
    {
      identity: {
        version: 1,
        rev: 3,
        day: 3,
        name: '阿岚',
        beliefs: [],
        scars: 0,
        refusals: 0,
        refuted: 0,
        mode: { order: 'R>E', split: false },
        updatedAt: NOW,
      },
      self: `# 我\n\n${SELF_TEXT}`,
      bonds: [{ slug: '他', text: BOND_TEXT, rev: 1, at: NOW }],
    },
    { now: NOW },
  )
  const bundle = path.join(dir, 'soul.json')
  const out = exportSoulBundle({ root: srcRoot, store, now: NOW, outPath: bundle })
  store.close()
  assert.equal(out.ok, true, `导出失败：${out.reason || ''}`)
  return { bundle, srcRoot, dir }
}

// ---------------------------------------------------------------- rebuild-card

test('rebuild-card：两条 applied（self + bond）重建出 self.md / bonds/他.json / identity', async () => {
  const { root, store } = await storeWithPatches()
  try {
    const out = rebuildCardFromEvents({ root, store, now: NOW })
    assert.equal(out.ok, true)
    assert.equal(out.wrote, 2)
    assert.deepEqual(out.self, { rev: 1, chars: [...SELF_TEXT].length })
    assert.deepEqual(out.bonds, [{ name: '他', rev: 2, chars: [...BOND_TEXT].length }])

    const p = cardPaths(root)
    const selfRaw = readFileSync(p.self, 'utf8')
    assert.equal(selfRaw.split('\n')[0], '# 我', 'self.md 第一行必须是 `# 我`')
    assert.ok(selfRaw.includes('我是一条会长的鱼。'), 'self.md 没写进事件里的正文')
    assert.ok(selfRaw.includes('我答应之前会先停一下。'))

    const bond = JSON.parse(readFileSync(path.join(p.bondsDir, '他.json'), 'utf8'))
    assert.equal(bond.slug, '他')
    assert.equal(bond.text, BOND_TEXT)
    assert.equal(bond.rev, 2)

    const identity = JSON.parse(readFileSync(p.identity, 'utf8'))
    assert.equal(identity.rev, 2, 'identity.rev 应该取到最大的那个 rev')
    assert.equal(identity.mode.order, 'E=R')
    assert.equal(out.identity.rev, 2)
    assert.equal(statSync(p.self).mode & 0o222, 0, 'self.md 应该锁成 0444')
    assert.equal(statSync(path.join(p.bondsDir, '他.json')).mode & 0o222, 0, 'bonds 应该锁成 0444')
  } finally {
    store.close()
  }
})

test('rebuild-card：dry 只算不写（card/ 一个文件都不建）', async () => {
  const { root, store } = await storeWithPatches()
  try {
    const out = rebuildCardFromEvents({ root, store, now: NOW, dry: true })
    assert.equal(out.ok, true)
    assert.equal(out.wrote, 0)
    assert.deepEqual(out.self, { rev: 1, chars: [...SELF_TEXT].length })
    assert.deepEqual(out.bonds, [{ name: '他', rev: 2, chars: [...BOND_TEXT].length }])
    assert.equal(out.identity, null)

    const p = cardPaths(root)
    assert.equal(existsSync(p.self), false)
    assert.equal(existsSync(p.bondsDir), false)
    assert.equal(existsSync(p.state), false)
    assert.equal(existsSync(p.dir), false)
  } finally {
    store.close()
  }
})

test('rebuild-card：没有 card_patch → wrote:0，不建 self.md', async () => {
  const root = tmp('rebuild-empty')
  const store = await createStore({ root, forceJsonl: true })
  try {
    await store.append({ type: 'utterance', ts: NOW, text: '只是说了一句。', source: 'tool' })
    const out = rebuildCardFromEvents({ root, store, now: NOW })
    assert.equal(out.ok, true)
    assert.equal(out.wrote, 0)
    assert.equal(out.self, null)
    assert.deepEqual(out.bonds, [])
    assert.equal(out.identity, null)
    assert.equal(existsSync(cardPaths(root).self), false)
    assert.equal(existsSync(cardPaths(root).dir), false)
  } finally {
    store.close()
  }
})

test('rebuild-card：state.json 仍可写（重建后 writeProjection 不抛 EPERM）', async () => {
  const { root, store } = await storeWithPatches()
  try {
    const first = rebuildCardFromEvents({ root, store, now: NOW })
    assert.equal(first.ok, true)

    const statePath = cardPaths(root).state
    assert.ok(existsSync(statePath))
    assert.ok(writable(statePath), `state.json 不该是只读（mode=${(statSync(statePath).mode & 0o777).toString(8)}）`)

    // 真正会踩 EPERM 的是下一次投影：它要重写 state.json。
    let identity = null
    assert.doesNotThrow(() => {
      identity = writeProjection(root, { store, now: NOW + 5000 })
    }, 'writeProjection 写 state.json 时报了 EPERM（多半被 chmod 444 了）')
    assert.equal(identity.rev, 2)
    assert.equal(writable(statePath), true, 'writeProjection 之后 state.json 还得可写')
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------- revive

test('revive：导出再复活 → imported>0、链 ok、日记（含 day 0）与卡都回来', async () => {
  const { bundle } = await makeBundle()
  const root = tmp('revive-ok')
  const out = await revive({ bundle, root, now: NOW })
  const store = out.store
  try {
    assert.equal(out.ok, true, `复活失败：${out.reason || ''} ${JSON.stringify(out.problems || [])}`)
    assert.equal(out.manifest.ok, true)
    assert.equal(out.manifest.legacy.length, 0)
    assert.equal(out.imported, 2)
    assert.equal(out.skipped, 0)
    assert.equal(out.failed, 0)
    assert.ok(out.firstId && out.lastId)
    assert.equal(out.chain.ok, true)
    assert.equal(out.diary.imported, 2, '两篇日记（含 day 0）都要回来')
    assert.equal(out.card.bonds, 1)

    assert.equal(existsSync(path.join(root, 'events.db')), true, 'sqlite 后端应该在 root 下建 events.db')
    assert.equal(store.readAll().length, 2)
    assert.equal(store.diaryAll().length, 2)
    assert.ok(store.diaryAll().some((d) => Number(d.day) === 0), 'day 0 那篇不能被吃掉')

    const card = readCard(root)
    assert.ok(card.self.includes('我是一条会长的鱼。'))
    assert.equal(card.bonds.length, 1)
    assert.equal(card.bonds[0].slug, '他')
    assert.equal(card.bonds[0].text, BOND_TEXT)
  } finally {
    try {
      store?.close()
    } catch {}
  }
})

test('revive --dry：只核清单，不建库（root 下没有 events.db）', async () => {
  const { bundle } = await makeBundle()
  const root = tmp('revive-dry')
  const out = await revive({ bundle, root, now: NOW, dry: true })
  assert.equal(out.ok, true)
  assert.equal(out.dry, true)
  assert.equal(out.manifest.ok, true)
  assert.equal(out.manifest.problems.length, 0)
  assert.equal(out.imported, 0)
  assert.equal(out.store, undefined, 'dry 不该建库，也不该返回 store')
  assert.equal(existsSync(path.join(root, 'events.db')), false)
  assert.equal(existsSync(path.join(root, 'events.jsonl')), false)
  assert.equal(existsSync(path.join(root, 'card')), false)
})

test('revive：清单被改过的包 → ok:false，一个文件都不写', async () => {
  const { bundle, dir } = await makeBundle()
  const doc = JSON.parse(readFileSync(bundle, 'utf8'))
  doc.events[0].text = '被外面改过的一句。'
  const tampered = path.join(dir, 'tampered.soul.json')
  writeFileSync(tampered, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')

  const root = tmp('revive-bad')
  const out = await revive({ bundle: tampered, root, now: NOW })
  assert.equal(out.ok, false)
  assert.equal(out.reason, '清单对不上')
  assert.equal(out.manifest.ok, false)
  assert.ok(out.problems.length > 0)
  assert.match(out.problems.join('；'), /events\.jsonl 指纹对不上/)
  assert.equal(out.imported, 0)
  assert.deepEqual(readdirSync(root), [], '清单不过时 root 下一字节都不该多')
})

test('CLI 冒烟：node tools/revive.mjs --bundle … --root … --dry 退出码 0 且输出含 manifest', async () => {
  const { bundle } = await makeBundle()
  const root = tmp('revive-cli')
  const r = spawnSync(process.execPath, [CLI_REVIVE, '--bundle', bundle, '--root', root, '--dry'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(r.status, 0, `CLI 退出码 ${r.status}，stderr=${r.stderr}`)
  assert.match(r.stdout, /"manifest"/)
  const summary = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.equal(summary.ok, true)
  assert.equal(summary.manifest.ok, true)
  assert.equal(summary.dry, true)
  assert.equal(existsSync(path.join(root, 'events.db')), false)
})
