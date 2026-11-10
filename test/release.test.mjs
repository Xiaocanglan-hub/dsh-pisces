// 发布版（0.1.0）：release 标记一开，开发者钥匙整条线都不该出现。
// 用临时 package.json / 依赖注入模拟，不读真实用户目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readRelease } from '../index.js'
import { toolDefs } from '../lib/tools.js'
import { handle, PREFIX } from '../lib/console.js'
import { FIXED_PERSONA } from '../lib/persona.js'

const ADULT_DEMO = {
  selfInspect: true,
  teach: true,
  guide: true,
  check: true,
  nickname: true,
  devkey: true,
}

/** 成年鱼 12/13 个动作需要的最小依赖；release 由每个用例显式给。 */
function adultDeps(overrides = {}) {
  return {
    getStore: async () => ({ readAll: () => [] }),
    log: () => {},
    patchCard: async () => ({ ok: true, decision: 'applied', rev: 1 }),
    look: async () => ({ ok: true, titles: [] }),
    speak: async () => ({ ok: true }),
    selfView: async () => ({ ok: true, view: { day: 1 } }),
    teach: async () => '一段话',
    guide: { guideFor: () => '一段引导', nextStep: () => ({ text: '先起个点' }) },
    check: () => '[看不出] 面板没读出来',
    setNickname: async (name) => ({ ok: true, name }),
    verifyDevkey: () => true,
    demo: ADULT_DEMO,
    ...overrides,
  }
}

const namesOf = (defs) => defs.map((d) => d.name)
const tmpPkg = () => path.join(mkdtempSync(path.join(tmpdir(), 'pisces-release-')), 'package.json')
const url = (p) => `${PREFIX}${p}`

test('release：release=true 时成年鱼 12 个动作、没有 pisces_dev（临时 package.json 读标记）', () => {
  const file = tmpPkg()
  // 临时 package.json：读标记本身（不碰真实工作副本）。
  writeFileSync(file, JSON.stringify({ dsh: { pisces: { release: true } } }), 'utf8')
  assert.equal(readRelease(file), true)
  writeFileSync(file, JSON.stringify({ dsh: { pisces: { release: false } } }), 'utf8')
  assert.equal(readRelease(file), false, 'release:false 是开发版')
  assert.equal(readRelease(path.join(path.dirname(file), 'missing.json')), false, '缺文件当开发版')

  // 就算有人手滑把 devkey/verifyDevkey/root 都传进来，release=true 也不注册。
  const defs = toolDefs(adultDeps({ release: true, root: path.dirname(file) }))
  assert.equal(defs.length, 12, namesOf(defs).join(','))
  assert.equal(namesOf(defs).includes('pisces_dev'), false)
})

test('release：console deps 没有 devkey 时 /devkey 回 404，不泄露入口存在', async () => {
  for (const [method, body] of [['GET'], ['POST', { rotate: true }], ['DELETE']]) {
    const res = await handle({ method, url: url('/devkey'), body: body && JSON.stringify(body) }, {})
    assert.equal(res.status, 404, `${method} 应该是 404`)
    assert.equal(res.body.includes('devkey'), false, '响应里不许出现 devkey')
    assert.equal(res.body.includes('钥匙'), false, '响应里不许出现「钥匙」')
  }

  // 开发版注入 devkey 依赖时路由才存在；证明 404 是因为依赖没传，而不是路由被删。
  const dev = await handle({ method: 'GET', url: url('/devkey') }, { devkey: () => ({ ok: true, hasKey: false }) })
  assert.equal(dev.status, 200)
})

test('release：release=false 时仍是 13 个、pisces_dev 在（开发版不回归）', () => {
  const defs = toolDefs(adultDeps({ release: false }))
  assert.equal(defs.length, 13, namesOf(defs).join(','))
  assert.equal(namesOf(defs).includes('pisces_dev'), true)
})

test('release：FIXED_PERSONA 是烘进去的定稿（含「数字生命」，不再有「你不用防着他」）', () => {
  assert.ok(FIXED_PERSONA.includes('数字生命'), '固定段缺「数字生命」')
  assert.ok(FIXED_PERSONA.startsWith('你是大肥鱼的其中一员'), '固定段要从群体那句开始')
  assert.equal(FIXED_PERSONA.includes('你不用防着他'), false, '用户定稿时删掉的句子不能再回来')
  assert.equal(/[0-9０-９]/.test(FIXED_PERSONA), false, '固定段里不许有数字')
})
