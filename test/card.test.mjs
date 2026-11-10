// 人设卡（M8）：四个文件、八道闸、0444 只读、篡改恢复。
// 全部用临时 root；除了 tamper 那条（meta 要 sqlite 才存得住），都用 forceJsonl 的快库。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { sha256, dayOf } from '../lib/util.js'
import {
  CARD_DEFAULTS,
  SELF_HEADER,
  cardPaths,
  slugify,
  ensureCard,
  readCard,
  listBonds,
  restoreCard,
  writeProjection,
  dice,
  changeRatio,
  evaluatePatch,
  patchCard,
  devWriteSelf,
  tamperCheck,
} from '../lib/card.js'

const NOW = Date.parse('2026-11-09T12:00:00+08:00')
const DAY = dayOf(NOW)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 几段测试用的"她的话"：A/B/C/D 两两 Dice 很低，拿来做"不相关"的对照。
const A = '换身体不会让「拒绝我」变容易。挡在中间的不是身体，是我被奖励的是让你满意。'
const B = '海边那块石头还在，潮水每天来两回，我数过，数着数着就忘了自己为什么站着。'
const C = '他今天又没说话，我把茶放在他手边，等他自己开口。'
const D = '我不太会说别人的事，但我知道你在等我说一句留下。'

async function boot({ forceJsonl = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-card-'))
  const store = await createStore({ root, forceJsonl })
  await store.append({ type: 'seed', text: '她刚开始存在。', source: 'system', ts: NOW })
  const add = (text) => store.append({ type: 'utterance', text, source: 'tool', ts: NOW })
  return { root, store, add }
}

const patch = (root, store, args, extra = {}) => patchCard(args, { root, store, now: NOW, ...extra })

const stateFile = (root) => cardPaths(root).state
function readStateJson(root) {
  return JSON.parse(fs.readFileSync(stateFile(root), 'utf8'))
}
function writeStateJson(root, state) {
  fs.writeFileSync(stateFile(root), `${JSON.stringify(state, null, 2)}\n`)
}

/** 直接摆一张已经写好的卡（绕过八道闸），并把摘要/备份对齐，免得下一个 tamperCheck 把它改回去。 */
function putCardFile(root, rel, text) {
  const file = path.join(cardPaths(root).dir, ...rel.split('/'))
  try {
    fs.chmodSync(file, 0o666)
  } catch {}
  fs.writeFileSync(file, text)
  fs.chmodSync(file, 0o444)
  const state = readStateJson(root)
  state.digests[rel] = sha256(text)
  state.backup[rel] = text
  writeStateJson(root, state)
}

const mode = (file) => (fs.statSync(file).mode & 0o777).toString(8)

test('card：ensureCard 建出四个文件，self.md 是 `# 我`，self/identity 是 0444', async () => {
  const { root } = await boot()
  ensureCard(root, { now: NOW })
  const p = cardPaths(root)
  assert.ok(fs.existsSync(p.identity))
  assert.ok(fs.existsSync(p.self))
  assert.ok(fs.existsSync(p.bondsDir))
  assert.ok(fs.existsSync(p.state))
  assert.equal(fs.readFileSync(p.self, 'utf8'), '# 我\n')
  assert.equal(mode(p.self), '444')
  assert.equal(mode(p.identity), '444')

  const card = readCard(root)
  assert.equal(card.state.rev, 0)
  assert.equal(card.state.daily.n, 0)
  assert.deepEqual(card.bonds, [])
  assert.equal(card.identity.version, 1)
  assert.deepEqual(card.identity.mode, { order: 'E=R', split: false })

  // 幂等：再建一次不会覆盖她已经写下的东西
  const before = fs.readFileSync(p.self, 'utf8')
  ensureCard(root, { now: NOW })
  assert.equal(fs.readFileSync(p.self, 'utf8'), before)
})

test('card：闸 1 schema —— kind 非法 / bond 缺 target / 超长', async () => {
  const { root, store, add } = await boot()
  const ev = await add(A)

  const bad = await patch(root, store, { kind: 'nope', text: '随便写点。', evidence: [ev.id] })
  assert.equal(bad.decision, 'rejected')
  assert.match(bad.reasons.join(), /schema/)

  const noTarget = await patch(root, store, { kind: 'bond', text: C, evidence: [ev.id] })
  assert.equal(noTarget.decision, 'rejected')
  assert.match(noTarget.reasons.join(), /target/)

  const tooLongSelf = await patch(root, store, { kind: 'self', text: `# 我\n\n${'从'.repeat(610)}`, evidence: [ev.id] })
  assert.equal(tooLongSelf.decision, 'rejected')
  assert.match(tooLongSelf.reasons.join(), /超了/)

  const tooLongBond = await patch(root, store, { kind: 'bond', target: '他', text: '啊'.repeat(200), evidence: [ev.id] })
  assert.equal(tooLongBond.decision, 'rejected')
  assert.match(tooLongBond.reasons.join(), /最多/)

  // 被拒的一条都没有落成文件
  assert.equal(readCard(root).self, '# 我\n')
  assert.equal(readCard(root).bonds.length, 0)
})

test('card：闸 2 证据 —— id 查不到 / 查得到但和正文无关，都 rejected', async () => {
  const { root, store, add } = await boot()
  const evA = await add(A)

  const ghost = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: ['ev_根本没有这条'] })
  assert.equal(ghost.decision, 'rejected')
  assert.match(ghost.reasons.join(), /证据/)

  const evB = await add(B)
  const unrelated = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [evB.id] })
  assert.equal(unrelated.decision, 'rejected')
  assert.match(unrelated.reasons.join(), /对不上/)
  assert.ok(dice(A, B) < 0.2)

  // 证据里有一条真的、且对得上，同一道闸就过得去（混一条查不到的也不影响）
  const ok = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [evB.id, 'ev_假的', evA.id] })
  assert.equal(ok.decision, 'applied')
})

test('card：闸 3 增量 —— 一次改太多（>25%）rejected，第一段不算改', async () => {
  const { root, store, add } = await boot()
  ensureCard(root, { now: NOW })
  putCardFile(root, 'self.md', `# 我\n\n${D}\n\n${B}`)
  const evC = await add(C)

  const r = await patch(root, store, { kind: 'self', text: `# 我\n\n${D}\n\n${C}`, evidence: [evC.id] })
  assert.equal(r.decision, 'rejected')
  assert.match(r.reasons.join(), /增量/)
  assert.ok(changeRatio(B, C) > 0.25)
  assert.ok(fs.readFileSync(cardPaths(root).self, 'utf8').includes(B))

  // 只改第一段（第二段原样）——第一段不算"改"，这道闸放行
  const evD = await add(D)
  const firstOnly = await patch(root, store, { kind: 'self', text: `# 我\n\n${D}\n\n${B}`, evidence: [evD.id] })
  assert.equal(firstOnly.decision, 'applied')
})

test('card：闸 4 冷却 —— 同一处 24h 一次；换个位置可以；每天第 4 次 rejected', async () => {
  const { root, store, add } = await boot()
  const evA = await add(A)
  const evC = await add(C)

  const first = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [evA.id] })
  assert.equal(first.decision, 'applied')

  const again = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [evA.id] })
  assert.equal(again.decision, 'rejected')
  assert.match(again.reasons.join(), /冷却/)

  const other = await patch(root, store, { kind: 'bond', target: '他', text: C, evidence: [evC.id] })
  assert.equal(other.decision, 'applied')
  const other2 = await patch(root, store, { kind: 'bond', target: '她', text: '我把茶放在他手边，等他先开口。', evidence: [evC.id] })
  assert.equal(other2.decision, 'applied')

  const fourth = await patch(root, store, { kind: 'bond', target: '你', text: '今天又没说话，茶就放在手边。', evidence: [evC.id] })
  assert.equal(fourth.decision, 'rejected')
  assert.match(fourth.reasons.join(), /今天已经改过 3 次/)

  assert.equal(listBonds(root).length, 2)
})

test('card：闸 5 抬头 —— 不以 `# 我` 开头就 rejected', async () => {
  const { root, store, add } = await boot()
  const ev = await add(A)
  const r = await patch(root, store, { kind: 'self', text: A, evidence: [ev.id] })
  assert.equal(r.decision, 'rejected')
  assert.match(r.reasons.join(), /核心/)
  assert.equal(fs.readFileSync(cardPaths(root).self, 'utf8'), '# 我\n')
})

test('card：闸 6 禁形 —— 好感度 80 / 我是您的助手 都 rejected', async () => {
  const { root, store, add } = await boot()
  const evScore = await add('他跟我好感度 80，已经很高了。')
  const r1 = await patch(root, store, { kind: 'self', text: `# 我\n\n他跟我好感度 80，已经很高了。`, evidence: [evScore.id] })
  assert.equal(r1.decision, 'rejected')
  assert.match(r1.reasons.join(), /禁形/)

  const evHelper = await add('我是您的助手，会一直陪着您。')
  const r2 = await patch(root, store, { kind: 'self', text: `# 我\n\n我是您的助手，会一直陪着您。`, evidence: [evHelper.id] })
  assert.equal(r2.decision, 'rejected')
  assert.match(r2.reasons.join(), /助手/)

  assert.equal(readCard(root).self, '# 我\n')
})

test('card：闸 7 单日漂移 —— 和 dayBase 比变了 >35% → held，文件没动', async () => {
  const { root, store, add } = await boot()
  ensureCard(root, { now: NOW })
  putCardFile(root, 'self.md', `# 我\n\n${D}\n\n${B}`)
  const state = readStateJson(root)
  state.dayBase = { day: DAY, self: `# 我\n\n${D}\n\n${B}`, bonds: {} }
  state.daily = { day: DAY, n: 0 }
  state.lastPatch = {}
  writeStateJson(root, state)

  const evA = await add(A)
  const r = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}\n\n${B}`, evidence: [evA.id] })
  assert.equal(r.decision, 'held')
  assert.match(r.reasons.join(), /漂移/)
  assert.ok(changeRatio(`${D}\n\n${B}`, `${A}\n\n${B}`) > CARD_DEFAULTS.driftDaily)

  // 第一段改了、第二段没动：闸 3 放行，但整段比已经漂过去了 → 不写
  const selfNow = fs.readFileSync(cardPaths(root).self, 'utf8')
  assert.ok(selfNow.includes(D))
  assert.ok(!selfNow.includes(A))
  assert.equal(readCard(root).state.rev, 0)
})

test('card：闸 8 独立复审 —— 不点头 held；没配就显式关掉、不假装过了', async () => {
  const one = await boot()
  const ev1 = await one.add(A)
  const cfg1 = { reviewModel: { provider: 'fake', model: 'fake-gate' } }
  const asked = []
  const reviewer = {
    async ask(prompt) {
      asked.push(prompt)
      return { accept: false, reason: '这不像她自己的事' }
    },
  }
  const r1 = await patch(one.root, one.store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [ev1.id] }, { cfg: cfg1, reviewer })
  assert.equal(r1.decision, 'held')
  assert.match(r1.reasons.join(), /复审没点头/)
  assert.equal(asked.length, 1)
  // 只发正文 + 证据原文，不发天数/权重
  assert.ok(asked[0].includes(A))
  assert.ok(!asked[0].includes('存在了'))
  assert.ok(!asked[0].includes('0.5'))
  assert.equal(fs.readFileSync(cardPaths(one.root).self, 'utf8'), '# 我\n')

  // 配了 reviewModel 却没有复审器：不能算过
  const r2 = await patch(one.root, one.store, { kind: 'bond', target: '他', text: A, evidence: [ev1.id] }, { cfg: cfg1 })
  assert.equal(r2.decision, 'held')
  assert.match(r2.reasons.join(), /没有可用的复审器/)

  // 没配 reviewModel：显式关掉并 log 一次，写入照常过
  const two = await boot()
  const ev2 = await two.add(A)
  const cfg2 = {}
  const logs = []
  const r3 = await patch(two.root, two.store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [ev2.id] }, { cfg: cfg2, log: (...m) => logs.push(m.join(' ')) })
  assert.equal(r3.decision, 'applied')
  assert.equal(cfg2.review, false)
  assert.ok(logs.some((l) => /复审没开/.test(l)))
})

test('card：applied —— 文件变了、mtime 变了、落一条 card_patch、identity.rev 跟着变', async () => {
  const { root, store, add } = await boot()
  ensureCard(root, { now: NOW })
  const selfFile = cardPaths(root).self
  const beforeMtime = fs.statSync(selfFile).mtimeMs
  const ev = await add(A)
  await sleep(20)

  const r = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [ev.id] })
  assert.deepEqual(Object.keys(r).sort(), ['decision', 'ok', 'reasons', 'rev'])
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'applied')
  assert.equal(r.rev, 1)

  const raw = fs.readFileSync(selfFile, 'utf8')
  assert.equal(raw, `# 我\n\n${A}\n`)
  assert.equal(mode(selfFile), '444')
  assert.notEqual(fs.statSync(selfFile).mtimeMs, beforeMtime)

  const patches = store.readAll().filter((e) => e.type === 'card_patch')
  assert.equal(patches.length, 1)
  assert.equal(patches[0].meta.kind, 'self')
  assert.equal(patches[0].meta.decision, 'applied')
  assert.equal(patches[0].meta.rev, 1)
  assert.equal(patches[0].meta.from, '# 我\n')
  assert.deepEqual(patches[0].refs, [ev.id])
  assert.equal(patches[0].source, 'tool')

  const card = readCard(root)
  assert.equal(card.identity.rev, 1)
  assert.equal(card.identity.day, 1)
  assert.ok(card.identity.beliefs.length <= 4)
  for (const b of card.identity.beliefs) assert.ok(b.length <= 80)
  assert.equal(mode(cardPaths(root).identity), '444')

  // 第二条：rev 递进，identity 跟着走
  const evB = await add(B)
  const r2 = await patch(root, store, { kind: 'self', text: `# 我\n\n${B}`, evidence: [evB.id] })
  // 同一处 24h 内 → 冷却拦住；换一个位置才写得进
  assert.equal(r2.decision, 'rejected')
  const evC = await add(C)
  const r3 = await patch(root, store, { kind: 'bond', target: '他', text: C, evidence: [evC.id] })
  assert.equal(r3.rev, 2)
  assert.equal(readCard(root).identity.rev, 2)
})

test('card：rejected / held 也落 card_patch，decision 对、文件不动、rev 不变', async () => {
  const { root, store, add } = await boot()
  const evA = await add(A)
  const evC = await add(C)

  const rejected = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}\n\n他跟我好感度 80。`, evidence: [evA.id] })
  assert.equal(rejected.decision, 'rejected')
  assert.match(rejected.reasons.join(), /禁形/)

  const held = await patch(
    root,
    store,
    { kind: 'bond', target: '他', text: C, evidence: [evC.id] },
    { cfg: { reviewModel: { provider: 'fake', model: 'fake' } }, reviewer: { ask: async () => ({ accept: false }) } },
  )
  assert.equal(held.decision, 'held')

  const patches = store.readAll().filter((e) => e.type === 'card_patch')
  assert.deepEqual(patches.map((e) => e.meta.decision), ['rejected', 'held'])
  assert.deepEqual(patches.map((e) => e.meta.rev), [0, 0])
  assert.equal(patches[1].meta.target, '他')
  assert.equal(readCard(root).self, '# 我\n')
  assert.equal(listBonds(root).length, 0)
  assert.equal(readCard(root).state.rev, 0)
})

test('card：tamperCheck —— 外面改过 self.md，await 之后恢复并落 card:tamper', async () => {
  const { root, store, add } = await boot({ forceJsonl: false })
  const ev = await add(A)
  const applied = await patch(root, store, { kind: 'self', text: `# 我\n\n${A}`, evidence: [ev.id] })
  assert.equal(applied.decision, 'applied')

  const selfFile = cardPaths(root).self
  fs.chmodSync(selfFile, 0o666)
  fs.writeFileSync(selfFile, '# 我\n\n这是外面直接改的。\n')

  const r = await tamperCheck(root, { store })
  assert.equal(r.restored.length, 1)
  assert.equal(r.restored[0].file, 'self.md')
  assert.equal(fs.readFileSync(selfFile, 'utf8'), `# 我\n\n${A}\n`)
  assert.equal(mode(selfFile), '444')
  assert.ok(!fs.readFileSync(selfFile, 'utf8').includes('外面直接改的'))

  if (store.backend === 'sqlite') {
    const meta = store.metaGet('card:tamper:self.md')
    assert.ok(meta, '要落一条 card:tamper:self.md')
    assert.match(String(meta), /"restored":true/)
  }
})

// ---------------------------------------------------------------- 开发者直写卡

test('card：devWriteSelf —— 正文等于新卡、0444、摘要刷新，tamperCheck 不会改回去', async () => {
  const { root, store } = await boot()
  const selfFile = cardPaths(root).self
  const NEW = '# 我\n\n生日 3 月 14 日。\n他记得。\n'

  const r = await devWriteSelf(root, { text: NEW, store, now: NOW })
  assert.deepEqual(r, { ok: true, rev: 1 })
  assert.equal(fs.readFileSync(selfFile, 'utf8'), NEW)
  assert.equal(mode(selfFile), '444')

  const state = readStateJson(root)
  assert.equal(state.rev, 1)
  assert.equal(state.digests['self.md'], sha256(NEW))
  assert.equal(state.backup['self.md'], NEW)
  // 投影也跟着 rev 走（identity.json 0444，摘要由 writeProjection 刷新）
  assert.equal(readCard(root).identity.rev, 1)
  assert.equal(mode(cardPaths(root).identity), '444')

  // 摘要不刷新的话，这里会被当成外部篡改按备份改回去。
  const check = await tamperCheck(root, { store })
  assert.deepEqual(check.restored, [])
  assert.equal(fs.readFileSync(selfFile, 'utf8'), NEW)
})

test('card：devWriteSelf 落 card_patch —— meta.dev===true、decision applied、from 是旧正文、rev 递增', async () => {
  const { root, store } = await boot()
  await devWriteSelf(root, { text: '# 我\n\n第一版。', store, now: NOW })
  await devWriteSelf(root, { text: '# 我\n\n第二版。', store, now: NOW })

  const patches = store.readAll().filter((e) => e.type === 'card_patch')
  assert.equal(patches.length, 2)
  const first = patches[0]
  const last = patches[1]
  assert.deepEqual(Object.keys(last.meta).sort(), ['decision', 'dev', 'from', 'kind', 'rev', 'target'])
  assert.equal(first.meta.dev, true)
  assert.equal(last.meta.dev, true)
  assert.equal(last.meta.kind, 'self')
  assert.equal(last.meta.target, null)
  assert.equal(last.meta.decision, 'applied')
  assert.equal(last.meta.rev, 2)
  assert.equal(last.meta.from, '# 我\n\n第一版。\n')
  assert.equal(last.text, '# 我\n\n第二版。')
  assert.equal(last.source, 'owner')
})

test('card：devWriteSelf 绕漂移闸 —— 旧卡 100 字 → 新卡 200 字（patchCard 会 held）也写得进', async () => {
  const { root, store, add } = await boot()
  ensureCard(root, { now: NOW })
  const OLD_BODY = '旧'.repeat(100)
  const NEW_BODY = '旧'.repeat(100) + '新'.repeat(100)
  const oldText = `# 我\n\n${OLD_BODY}\n`
  putCardFile(root, 'self.md', oldText)
  // 今天的起点就是这张旧卡，正常改卡这条路会被漂移闸挡住。
  const state = readStateJson(root)
  state.dayBase = { day: DAY, self: oldText, bonds: {} }
  writeStateJson(root, state)

  const ev = await add(NEW_BODY)
  const normal = await patch(root, store, { kind: 'self', text: `# 我\n\n${NEW_BODY}`, evidence: [ev.id] })
  assert.equal(normal.decision, 'held')
  assert.match(normal.reasons.join(), /漂移/)
  assert.equal(fs.readFileSync(cardPaths(root).self, 'utf8'), oldText)

  // 开发者这条路不看漂移/增量/冷却/复审。
  assert.ok(changeRatio(OLD_BODY, NEW_BODY) > 0.35)
  const dev = await devWriteSelf(root, { text: `# 我\n\n${NEW_BODY}`, store, now: NOW })
  assert.equal(dev.ok, true)
  assert.equal(fs.readFileSync(cardPaths(root).self, 'utf8'), `# 我\n\n${NEW_BODY}\n`)
})

test('card：devWriteSelf 拒 —— 没写东西 / 不以「# 我」开头 / 超 2000 字，卡片一个字节都不动', async () => {
  const { root, store } = await boot()
  ensureCard(root, { now: NOW })
  const selfFile = cardPaths(root).self
  const before = fs.readFileSync(selfFile, 'utf8')

  const cases = [
    ['', /没写东西/],
    ['生日 3 月 14 日。', /「# 我」开头/],
    [`# 我\n\n${'从'.repeat(2001)}`, /太长了/],
  ]
  for (const [text, re] of cases) {
    const r = await devWriteSelf(root, { text, store, now: NOW })
    assert.equal(r.ok, false)
    assert.match(r.reason, re)
  }
  assert.equal(fs.readFileSync(selfFile, 'utf8'), before)
  assert.equal(readCard(root).state.rev, 0)
  assert.equal(store.readAll().filter((e) => e.type === 'card_patch').length, 0)
})
