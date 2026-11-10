// 导出（M12）：CCv2 卡、soul bundle 自证、旧包 legacy 放行、带 id 原样导入、day 0、幂等。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'
import { readCard, restoreCard } from '../lib/card.js'
import { sha256 } from '../lib/util.js'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  exportCardV2,
  exportSoulBundle,
  readSoulBundle,
  verifySoulBundle,
  importSoulBundle,
} from '../lib/export.js'

const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const DAY = 86_400_000
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OLD_BUNDLE = path.resolve(HERE, '../../../exports/soul-2026-11-09.soul.json')

const NOW_DAY = '2026-11-09'

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-export-'))
  const store = await createStore({ root: path.join(root, 'store'), forceJsonl: true })
  return { root, store }
}

/** 种一条两天天前的起点（于是今天是第 3 天），再写几句她的话，最后摆一张卡。 */
async function bootWithCard() {
  const { root, store } = await mkStore()
  await store.append({ type: 'seed', ts: NOW - 2 * DAY, text: '你不是助手。你刚开始存在。', source: 'system' })
  const say = (text, ts = NOW - DAY) => store.append({ type: 'utterance', text, ts, source: 'tool' })
  await say('叫我阿岚。')
  await say('换身体不会让「拒绝我」变容易。')
  await say('海边那块石头还在，潮水每天来两回。')
  await say('我不太会说别人的事，但我知道你在等我说一句留下。')
  await say('他今天又没说话，我把茶放在他手边。')
  restoreCard(
    root,
    {
      identity: {
        version: 1,
        rev: 2,
        day: 3,
        name: null,
        beliefs: [],
        scars: 0,
        refusals: 0,
        refuted: 0,
        mode: { order: 'R>E', split: false },
        updatedAt: NOW,
      },
      self: '# 我\n\n我是一条会长的鱼。',
      bonds: [{ slug: '他', text: '他会回来的。', rev: 1, at: NOW }],
    },
    { now: NOW },
  )
  return { root, store }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}

function assertNoLocalPath(text) {
  assert.equal(text.includes('G:\\'), false, '正文里出现了 G:\\ 路径')
  assert.equal(text.includes('C:\\'), false, '正文里出现了 C:\\ 路径')
}

// ---------------------------------------------------------------- 1. CCv2 形状

test('CCv2：spec/spec_version/data 字段齐，description 有天数，personality 不带 `# 我`，creator_notes 提过去', async () => {
  const { root, store } = await bootWithCard()
  const r = exportCardV2({ root, store, now: NOW })
  assert.equal(r.ok, true)

  const doc = JSON.parse(readFileSync(r.path, 'utf8'))
  assert.equal(doc.spec, 'chara_card_v2')
  assert.equal(doc.spec_version, '2.0')
  const d = doc.data
  for (const k of [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'system_prompt',
    'post_history_instructions',
    'extensions',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(d, k), `data 缺 ${k}`)
  }
  assert.match(d.description, /你存在了 3 天。/)
  assert.match(d.description, /你管他叫阿岚。/)
  const bullets = d.description.split('\n').filter((l) => l.startsWith('- '))
  assert.ok(bullets.length >= 1 && bullets.length <= 4, `判断条数应在 1..4，实际 ${bullets.length}`)
  for (const b of bullets) assert.ok(b.length <= 84, `一条判断太长：${b.length}`)

  assert.equal(d.personality, '我是一条会长的鱼。')
  assert.equal(d.personality.includes('# 我'), false)
  assert.equal(d.system_prompt, '')
  assert.equal(d.post_history_instructions, '')
  assert.match(d.creator_notes, /过去/)

  assert.equal(doc.name, d.name)
  assert.equal(doc.personality, d.personality)
  assert.equal(doc.description, d.description)
  assert.equal(doc.scenario, d.scenario)

  const ext = d.extensions.dsh_pisces
  assert.equal(ext.day, 3)
  assert.equal(ext.order, 'E=R')
  assert.equal(ext.counts.beliefs, 5)
  assert.ok(ext.counts.refusals >= 0 && ext.counts.scars >= 0)
  assert.match(ext.identityHash, /^[0-9a-f]{64}$/)
  assert.equal(ext.exportedAt, NOW)
  assert.equal(r.bytes > 0, true)
  assert.equal(r.sha256, sha256(readFileSync(r.path, 'utf8')))
  store.close()
})

// ---------------------------------------------------------------- 2. 不落本机路径

test('CCv2 不落本机路径：整份导出里没有 G:\\ 或 C:\\', async () => {
  const { root, store } = await bootWithCard()
  const r = exportCardV2({ root, store, now: NOW })
  assert.equal(r.ok, true)
  assertNoLocalPath(readFileSync(r.path, 'utf8'))
  assertNoLocalPath(JSON.stringify(r.card))
  store.close()
})

// ---------------------------------------------------------------- 3. bundle 形状

test('bundle：events/diary/card 三项齐，manifest 四项，链 ok，字节数 > 0', async () => {
  const { root, store } = await bootWithCard()
  store.diaryPut([{ day: NOW_DAY, text: '今天把卡写好了。' }])
  const r = exportSoulBundle({ root, store, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.bytes > 0, true)

  const doc = JSON.parse(readFileSync(r.path, 'utf8'))
  assert.equal(doc.format, BUNDLE_FORMAT)
  assert.equal(doc.version, BUNDLE_VERSION)
  assert.equal(doc.createdAt, NOW)
  assert.equal(doc.chain.ok, true)

  assert.equal(Array.isArray(doc.events), true)
  assert.equal(doc.events.length, store.count())
  assert.deepEqual(doc.events.map((e) => e.seq), doc.events.map((e) => e.seq).slice().sort((a, b) => a - b))
  assert.equal(doc.diary.length, 1)
  assert.deepEqual(Object.keys(doc.card).sort(), ['bonds', 'identity', 'self'])
  assert.equal(doc.card.self.includes('# 我'), true)
  assert.equal(doc.card.bonds.length, 1)

  assert.deepEqual(
    Object.keys(doc.manifest.files).sort(),
    ['card/identity.json', 'card/self.md', 'diary.md', 'events.jsonl'],
  )
  assert.equal(doc.manifest.files['events.jsonl'].count, doc.events.length)
  assert.equal(doc.manifest.files['diary.md'].count, doc.diary.length)
  assert.equal(doc.manifest.files['events.jsonl'].sha256, sha256(JSON.stringify(doc.events)))
  assert.equal(doc.manifest.files['diary.md'].sha256, sha256(JSON.stringify(doc.diary)))

  // 不带本机路径
  assertNoLocalPath(readFileSync(r.path, 'utf8'))
  store.close()
})

// ---------------------------------------------------------------- 4. 清单自证

test('verifySoulBundle：刚导出的包自证通过（problems 空、legacy 空）', async () => {
  const { root, store } = await bootWithCard()
  const r = exportSoulBundle({ root, store, now: NOW })
  const doc = readSoulBundle(r.path)
  const v = verifySoulBundle(doc)
  assert.deepEqual(v.problems, [])
  assert.deepEqual(v.legacy, [])
  assert.equal(v.ok, true)
  store.close()
})

// ---------------------------------------------------------------- 5. 改一个事件就被拒

test('改一个事件 → verify 不过；import 拒收（清单对不上）且库里没多事件', async () => {
  const { root, store } = await bootWithCard()
  const r = exportSoulBundle({ root, store, now: NOW })
  const doc = JSON.parse(readFileSync(r.path, 'utf8'))
  doc.events[1].text = `${doc.events[1].text}（被改过）`
  const bad = writeJson(path.join(path.dirname(r.path), 'tampered.soul.json'), doc)

  const v = verifySoulBundle(readSoulBundle(bad))
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.includes('events.jsonl')))

  const dst = await mkStore()
  const imp = await importSoulBundle({ file: bad, store: dst.store, root: dst.root, now: NOW })
  assert.equal(imp.ok, false)
  assert.equal(imp.reason, '清单对不上')
  assert.ok(imp.problems.length >= 1)
  assert.equal(imp.imported, 0)
  assert.equal(dst.store.count(), 0) // 一个字节都没写
  dst.store.close()
  store.close()
})

// ---------------------------------------------------------------- 6. 旧包 legacy 放行

test('旧包（diary 清单没有 count、指纹不对）→ legacy:[diary.md]，导入成功', async () => {
  const dst = await mkStore()
  const r = await importSoulBundle({ file: OLD_BUNDLE, store: dst.store, root: dst.root, now: NOW })

  assert.equal(r.ok, true)
  assert.deepEqual(r.legacy, ['diary.md'])
  assert.equal(r.read, 670)
  assert.equal(r.imported, 670)
  assert.equal(r.skipped, 0)
  assert.equal(r.failed, 0)
  assert.equal(r.chain.ok, true)
  assert.equal(r.chain.count, 670)
  assert.equal(r.firstId, 'ev_01M6RAZG3YNYFPBXMCR1KPF4RC')
  assert.equal(r.diary.read, 2)
  // 旧包的 day 是数字 0 / 1：day 0 那篇不能丢
  assert.deepEqual(dst.store.diaryAll().map((d) => String(d.day)).sort(), ['0', '1'])
  assert.equal(readCard(dst.root).self.startsWith('# 我'), true)
  dst.store.close()
})

// ---------------------------------------------------------------- 7. 导入到新库

test('导入新库：id 原样、正文一致、链 ok、日记含 day 0、卡恢复', async () => {
  const events = [
    { seq: 1, id: 'ev_a', ts: NOW - 2 * DAY, day: '2026-11-07', type: 'seed', text: '你不是助手。', refs: [], meta: {}, confidence: null, source: 'migration' },
    { seq: 2, id: 'ev_b', ts: NOW - DAY, day: '2026-11-08', type: 'utterance', text: '我留下。', refs: [], meta: { mood: '静' }, confidence: 0.8, source: 'tool' },
    { seq: 3, id: 'ev_c', ts: NOW, day: NOW_DAY, type: 'refusal', text: '这句我不说。', refs: ['ev_a'], meta: {}, confidence: null, source: 'system' },
  ]
  const diary = [
    { day: 0, text: '第零天。' },
    { day: '2026-11-08', text: '第八天。' },
  ]
  const card = {
    identity: { version: 1, rev: 1, day: 2, name: null, beliefs: [], scars: 0, refusals: 0, refuted: 0, mode: { order: 'E=R', split: false }, updatedAt: NOW },
    self: '# 我\n\n我是一条会长的鱼。',
    bonds: [{ slug: '他', text: '他会回来的。', rev: 1, at: NOW }],
  }
  const doc = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: NOW,
    chain: { ok: true, count: 3, last: 'x' },
    events,
    diary,
    card,
    manifest: {
      files: {
        'events.jsonl': { count: events.length, sha256: sha256(JSON.stringify(events)) },
        'diary.md': { sha256: '0'.repeat(64) }, // 旧包：没有 count、指纹是旧算法
        'card/self.md': { sha256: sha256(card.self) },
        'card/identity.json': { sha256: sha256(JSON.stringify(card.identity)) },
      },
    },
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'pisces-export-bundle-'))
  const file = writeJson(path.join(dir, 'old.soul.json'), doc)

  const dst = await mkStore()
  const r = await importSoulBundle({ file, store: dst.store, root: dst.root, now: NOW })
  assert.equal(r.ok, true)
  assert.deepEqual(r.legacy, ['diary.md'])
  assert.equal(r.read, 3)
  assert.equal(r.imported, 3)
  assert.equal(r.skipped, 0)
  assert.equal(r.failed, 0)
  assert.equal(r.firstId, 'ev_a')
  assert.equal(r.lastId, 'ev_c')

  const all = dst.store.readAll()
  assert.deepEqual(all.map((e) => e.id), ['ev_a', 'ev_b', 'ev_c'])
  for (let i = 0; i < events.length; i++) {
    assert.equal(all[i].text, events[i].text)
    assert.equal(all[i].type, events[i].type)
    assert.equal(all[i].day, events[i].day)
  }
  assert.deepEqual(all[2].refs, ['ev_a'])
  assert.equal(all[1].meta.mood, '静') // 原 meta 保留
  assert.equal(all[1].meta.imported, 'soul')
  assert.equal(all[0].source, 'migration') // source 默认 migration
  assert.equal(dst.store.verify().ok, true)

  const back = dst.store.diaryAll()
  assert.equal(back.some((d) => String(d.day) === '0' && d.text === '第零天。'), true, 'day 0 丢了')
  assert.equal(back.some((d) => String(d.day) === '2026-11-08' && d.text === '第八天。'), true)

  const c = readCard(dst.root)
  assert.equal(c.self.includes('我是一条会长的鱼。'), true)
  assert.equal(c.self.startsWith('# 我'), true)
  assert.equal(c.identity.rev, 1)
  assert.equal(c.bonds.length, 1)
  assert.equal(c.bonds[0].slug, '他')
  dst.store.close()
})

// ---------------------------------------------------------------- 8. 幂等

test('幂等：同一份导两次，第二次 imported=0、skipped=N', async () => {
  const { root, store } = await bootWithCard()
  const r = exportSoulBundle({ root, store, now: NOW })
  const dst = await mkStore()

  const first = await importSoulBundle({ file: r.path, store: dst.store, root: dst.root, now: NOW })
  assert.equal(first.ok, true)
  assert.equal(first.imported, store.count())
  assert.equal(first.skipped, 0)

  const second = await importSoulBundle({ file: r.path, store: dst.store, root: dst.root, now: NOW })
  assert.equal(second.ok, true)
  assert.equal(second.imported, 0)
  assert.equal(second.skipped, store.count())
  assert.equal(second.failed, 0)
  assert.equal(second.firstId, null)
  assert.equal(dst.store.count(), store.count()) // 没翻倍
  assert.equal(dst.store.verify().ok, true)
  dst.store.close()
  store.close()
})

// ---------------------------------------------------------------- 9. 格式校验

test('readSoulBundle：不是本格式 / 版本太新 / 缺 events 都抛', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pisces-export-bad-'))
  const bad1 = writeJson(path.join(dir, 'other.json'), { format: 'something/else', version: 1, events: [] })
  assert.throws(() => readSoulBundle(bad1), /不是 dsh-pisces/)

  const bad2 = writeJson(path.join(dir, 'toonew.json'), { format: BUNDLE_FORMAT, version: BUNDLE_VERSION + 1, events: [] })
  assert.throws(() => readSoulBundle(bad2), /版本太新/)

  const bad3 = writeJson(path.join(dir, 'noevents.json'), { format: BUNDLE_FORMAT, version: BUNDLE_VERSION })
  assert.throws(() => readSoulBundle(bad3), /events/)

  const bad4 = path.join(dir, 'broken.json')
  writeFileSync(bad4, '{"format": "dsh-pisces/bundle",', 'utf8')
  assert.throws(() => readSoulBundle(bad4), /JSON/)
})

// ---------------------------------------------------------------- 10. 没写卡也如实

test('没写卡也能导：personality 如实为空，默认落 out/card-YYYY-MM-DD.json', async () => {
  const { root, store } = await mkStore()
  await store.append({ type: 'seed', ts: NOW, text: '你不是助手。', source: 'system' })
  const r = exportCardV2({ root, store, now: NOW })
  assert.equal(r.ok, true)
  assert.equal(path.basename(r.path), `card-${NOW_DAY}.json`)
  assert.equal(path.basename(path.dirname(r.path)), 'out')

  const doc = JSON.parse(readFileSync(r.path, 'utf8'))
  assert.equal(doc.data.personality, '')
  assert.equal(doc.personality, '')
  assert.match(doc.data.description, /你存在了 1 天。/)
  store.close()
})
