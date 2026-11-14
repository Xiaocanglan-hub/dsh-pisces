// meme（表情包）：包解析、校验、选图、路由解析。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MEME_MAX_BYTES,
  discoverPacks,
  memeUrl,
  packSummary,
  parsePack,
  pickMeme,
  resolveMemeFile,
} from '../lib/meme.js'
import { handle } from '../lib/console.js'
import { toolDefs } from '../lib/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUILTIN = path.join(HERE, '..', 'assets', 'memes', 'builtin')

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-meme-'))
}

test('内置包：能解析、八条、mood 正确', () => {
  const r = parsePack(BUILTIN, 'builtin')
  assert.equal(r.ok, true)
  assert.equal(r.pack.name, 'builtin')
  assert.equal(r.pack.entries.length, 8)
  assert.deepEqual(
    r.pack.entries.map((e) => e.id).sort(),
    ['annoyed-1', 'flat-1', 'happy-1', 'hmm-1', 'laugh-1', 'serious-1', 'shy-1', 'tired-1'],
  )
  const happy = r.pack.entries.find((e) => e.id === 'happy-1')
  assert.ok(happy.mood.includes('happy'))
  assert.equal(happy.intensity, 2)
})

test('坏包：没 pack.json / 空 entries / 条目全坏，都回 ok:false 不抛', () => {
  const root = mkRoot()
  const noJson = path.join(root, 'a')
  mkdirSync(noJson)
  assert.equal(parsePack(noJson).ok, false)

  const empty = path.join(root, 'b')
  mkdirSync(empty)
  writeFileSync(path.join(empty, 'pack.json'), JSON.stringify({ name: 'b', entries: [] }))
  assert.equal(parsePack(empty).ok, false)

  const bad = path.join(root, 'c')
  mkdirSync(bad)
  writeFileSync(path.join(bad, 'pack.json'), JSON.stringify({ name: 'c', entries: [{ id: '../x', file: 'x.png' }] }))
  assert.equal(parsePack(bad).ok, false)
})

test('条目校验：越界路径、坏 id、超大图、坏扩展名都会跳过', () => {
  const root = mkRoot()
  const dir = path.join(root, 'p')
  mkdirSync(dir)
  copyFileSync(path.join(BUILTIN, 'happy-1.png'), path.join(dir, 'ok.png'))
  writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(MEME_MAX_BYTES + 1))
  writeFileSync(path.join(dir, 'note.txt'), 'x')
  writeFileSync(
    path.join(dir, 'pack.json'),
    JSON.stringify({
      name: 'p',
      entries: [
        { id: 'ok', file: 'ok.png', mood: ['happy'], intensity: 9 },
        { id: '../escape', file: 'ok.png' },
        { id: 'bad id', file: 'ok.png' },
        { id: 'big', file: 'big.png' },
        { id: 'txt', file: 'note.txt' },
        { id: 'missing', file: 'nope.png' },
      ],
    }),
  )
  const r = parsePack(dir)
  assert.equal(r.ok, true)
  assert.equal(r.pack.entries.length, 1)
  const e = r.pack.entries[0]
  assert.equal(e.id, 'ok')
  assert.equal(e.intensity, 3, '强度夹到 1–3')
  assert.ok(r.pack.skipped >= 5)
})

test('discoverPacks：用户包同名覆盖内置，坏包跳过', () => {
  const root = mkRoot()
  const user = path.join(root, 'memes')
  const p1 = path.join(user, 'mine')
  mkdirSync(p1, { recursive: true })
  copyFileSync(path.join(BUILTIN, 'happy-1.png'), path.join(p1, 'a.png'))
  writeFileSync(
    path.join(p1, 'pack.json'),
    JSON.stringify({ name: 'mine', entries: [{ id: 'a', file: 'a.png', mood: ['happy'] }] }),
  )
  const p2 = path.join(user, 'builtin')
  mkdirSync(p2, { recursive: true })
  copyFileSync(path.join(BUILTIN, 'flat-1.png'), path.join(p2, 'b.png'))
  writeFileSync(
    path.join(p2, 'pack.json'),
    JSON.stringify({ name: 'builtin', entries: [{ id: 'b', file: 'b.png', mood: ['flat'] }] }),
  )
  mkdirSync(path.join(user, 'broken'))

  const packs = discoverPacks({ builtinDir: BUILTIN, userDir: user })
  const names = packs.map((p) => p.name).sort()
  assert.deepEqual(names, ['builtin', 'mine'])
  const builtin = packs.find((p) => p.name === 'builtin')
  assert.equal(builtin.source, 'user', '同名用户包覆盖内置')
  assert.equal(builtin.entries[0].id, 'b')
})

test('pickMeme：优先同 mood，避开最近用过的，全用过就返回 null', () => {
  const packs = discoverPacks({ builtinDir: BUILTIN })
  const picked = pickMeme(packs, { mood: 'happy', rand: () => 0.5 })
  assert.equal(picked.id, 'happy-1')
  assert.match(picked.url, /^\/dsh-pisces-api\/meme\/builtin\/happy-1\.png$/)

  // 目标 mood 唯一一张已用过 → 退到全池，挑别的 mood，而不是重发同一张
  const fallback = pickMeme(packs, { mood: 'happy', recent: ['happy-1'], rand: () => 0 })
  assert.notEqual(fallback, null)
  assert.notEqual(fallback.id, 'happy-1')

  // 全用过 → 宁可不发
  const all = packs.flatMap((p) => p.entries.map((e) => e.id))
  const withAllRecent = pickMeme(packs, { recent: all })
  assert.equal(withAllRecent, null)
})

test('pickMeme：空包 / 无参数都安全', () => {
  assert.equal(pickMeme([], {}), null)
  assert.equal(pickMeme([], { mood: 'happy' }), null)
})

test('resolveMemeFile：只认白名单内的包与 id，越界/不存在回 null', () => {
  const packs = discoverPacks({ builtinDir: BUILTIN })
  const hit = resolveMemeFile(packs, 'builtin', 'happy-1')
  assert.ok(hit && hit.type === 'image/png' && hit.file.endsWith('happy-1.png'))
  assert.equal(resolveMemeFile(packs, 'builtin', '../../etc/passwd'), null)
  assert.equal(resolveMemeFile(packs, '../builtin', 'happy-1'), null)
  assert.equal(resolveMemeFile(packs, 'nope', 'happy-1'), null)
  assert.equal(resolveMemeFile(packs, 'builtin', 'nope'), null)
})

test('packSummary / memeUrl：面板只拿计数，URL 做编码', () => {
  const packs = discoverPacks({ builtinDir: BUILTIN })
  const sum = packSummary(packs)
  assert.equal(sum.length, 1)
  assert.equal(sum[0].entries, 8)
  assert.equal(sum[0].source, 'builtin')
  assert.equal(memeUrl('a b', 'x/y'), '/dsh-pisces-api/meme/a%20b/x%2Fy.png')
})

test('观测台路由：/meme 清单、/meme/<包>/<id>.png 出图、越界 404、没装 503', async () => {
  const packs = discoverPacks({ builtinDir: BUILTIN })
  const deps = { memes: () => packs }

  const list = await handle({ method: 'GET', url: '/dsh-pisces-api/meme' }, deps)
  assert.equal(list.status, 200)
  assert.equal(JSON.parse(list.body).total, 8)

  const img = await handle({ method: 'GET', url: '/dsh-pisces-api/meme/builtin/happy-1.png' }, deps)
  assert.equal(img.status, 200)
  assert.equal(img.headers['content-type'], 'image/png')
  assert.ok(Buffer.isBuffer(img.body) && img.body.length > 0)

  const miss = await handle({ method: 'GET', url: '/dsh-pisces-api/meme/builtin/nope.png' }, deps)
  assert.equal(miss.status, 404)
  const traversal = await handle({ method: 'GET', url: '/dsh-pisces-api/meme/builtin/..%2Fsecret.png' }, deps)
  assert.equal(traversal.status, 404)

  const noDep = await handle({ method: 'GET', url: '/dsh-pisces-api/meme' }, {})
  assert.equal(noDep.status, 503)
})

test('工具面：有 selectMeme 才注册 pisces_meme，回执带 [表情 包/id]', async () => {
  const packs = discoverPacks({ builtinDir: BUILTIN })
  const deps = { selectMeme: async ({ mood }) => pickMeme(packs, { mood, rand: () => 0 }) }

  assert.equal(toolDefs({}).some((d) => d.name === 'pisces_meme'), false)

  const def = toolDefs(deps).find((d) => d.name === 'pisces_meme')
  assert.ok(def)
  const out = await def.execute({ mood: 'happy' })
  assert.match(out.text, /\[表情 builtin\/happy-1\]/)
  assert.ok(out.text.split('\n')[0].length > 0, '第一行是给人看的字')

  // mood 不认识不是错误：退到全池挑一张，照样有标记。
  const other = await def.execute({ mood: 'unknown' })
  assert.match(other.text, /\[表情 builtin\/[a-z0-9-]+\]/)
})

test('挑不到时工具不发；selectMeme 抛错也不炸', async () => {
  const none = { selectMeme: async () => null }
  const def = toolDefs(none).find((d) => d.name === 'pisces_meme')
  assert.match((await def.execute({})).text, /没发/)

  const boom = {
    selectMeme: async () => {
      throw new Error('x')
    },
  }
  const def2 = toolDefs(boom).find((d) => d.name === 'pisces_meme')
  assert.match((await def2.execute({})).text, /没发/)
})
