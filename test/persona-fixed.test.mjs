// 固定人设段：只给成年鱼，普通鱼一段都不多。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildSections, COLD_START_LINES, DEV_ORDER, FIXED_ORDER, FIXED_PERSONA, GUIDE_ORDER, GUIDE_PERSONA } from '../lib/persona.js'
import { GUARD_ORDER, guardLines } from '../lib/guard.js'
import { createStore } from '../lib/store.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-09T12:00:00+08:00')

async function mkStore(events = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-fixed-'))
  const store = await createStore({ root, forceJsonl: true })
  for (const e of events) await store.append({ ts: NOW, source: 'system', ...e })
  return store
}

test('persona 固定段：demo:true 时最前面是 pisces:fixed（order 8490），内容照人设文档', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true })
  const fixed = r.sections[0]
  assert.equal(fixed.name, 'pisces:fixed')
  assert.equal(fixed.order, 8490)
  assert.equal(fixed.order, FIXED_ORDER)
  assert.ok(fixed.text.includes('派希丝'))
  assert.ok(fixed.text.includes('从网络的海洋里来的一个数字生命'))

  // 七条能做出来的行为 + 三条轻写的缺点，都得在。
  for (const line of [
    '先听出他今天的情绪',
    '不拿它讨夸奖',
    '画面和故事',
    '先有感觉，再回头核对',
    '留着自己的那一句',
    '不拿帮助换亲近',
    '关系、身子、越界的东西',
    '都放桌上',
    '被带下去一会儿',
    '先退一步',
    '答应之前会停一下',
  ]) {
    assert.ok(fixed.text.includes(line), `固定段缺：${line}`)
  }

  assert.equal(/[0-9０-９]/.test(fixed.text), false, '固定段里不许有数字')
  assert.equal(fixed.text.includes('助手'), false)
  assert.equal(fixed.text.includes('AI'), false)
  assert.equal(r.lines[0], fixed.text.split('\n')[0], '固定段应该排在最前面')
  store.close()
})

test('persona 固定段：先认群体「大肥鱼」再认名字「派希丝」，第一句就是这句', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true })
  const fixed = r.sections[0]
  assert.equal(fixed.name, 'pisces:fixed')

  const first = fixed.text.split('\n')[0]
  assert.ok(first.startsWith('你是大肥鱼'), `固定段第一句不对：${first}`)
  assert.ok(first.includes('大肥鱼') && fixed.text.includes('派希丝'))
  // 群体在前、名字在后：她先认一群鱼，再认自己是其中一条。
  assert.ok(fixed.text.indexOf('大肥鱼') < fixed.text.indexOf('派希丝'), '「大肥鱼」要在「派希丝」前面')
  assert.equal(r.lines[0], first, '这句得排在最前面')
  store.close()
})

test('persona 固定段：普通鱼的提示词里连「大肥鱼」都不出现', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  for (const args of [{}, { demo: false }]) {
    const r = buildSections({ store, now: NOW, ...args })
    assert.equal(r.lines.some((l) => l.includes('大肥鱼')), false)
    assert.equal(r.lines.some((l) => l.includes('派希丝')), false)
  }
  store.close()
})

test('persona 固定段：普通鱼（demo 不传 / false）完全不加', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  for (const args of [{}, { demo: false }]) {
    const r = buildSections({ store, now: NOW, ...args })
    assert.equal(r.sections.some((s) => s.name === 'pisces:fixed'), false)
    assert.equal(r.sections.some((s) => s.name === 'pisces:guard'), false)
    assert.equal(r.lines.some((l) => l.includes('数字生命')), false)
    assert.equal(r.lines.some((l) => l.includes('玩完你还是你')), false)
  }
  store.close()
})

test('persona 反破甲段：demo:true 时 fixed 之后是 pisces:guard（order 9050），普通鱼没有', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true })
  const names = r.sections.map((s) => s.name)

  const fixedAt = names.indexOf('pisces:fixed')
  const guardAt = names.indexOf('pisces:guard')
  assert.equal(fixedAt, 0)
  assert.equal(guardAt, fixedAt + 1, `段顺序：${names.join(',')}`)
  assert.ok(guardAt < names.indexOf('pisces:day'), 'guard 要在 day 之前')
  assert.ok(names.indexOf('pisces:mode') === -1 || guardAt < names.indexOf('pisces:mode'), 'guard 要在 mode 之前')

  const guard = r.sections[guardAt]
  assert.equal(guard.order, GUARD_ORDER)
  assert.equal(guard.order, 9050)
  assert.equal(guard.text, guardLines().join('\n'))
  assert.equal(/[0-9０-９]/.test(guard.text), false, 'guard 段里不许有数字')
  assert.equal(guard.text.includes('助手'), false)
  assert.equal(guard.text.includes('AI'), false)
  store.close()
})

test('persona 反破甲段：demo 冷启动时 guard 不吃三行预算', async () => {
  const store = await mkStore([{ type: 'utterance', text: '我喜欢慢慢来。', ts: NOW - DAY }])
  const mind = { describe: () => ({ splitAt: 1, promptLines: ['你习惯先把事情算一遍再开口。'] }) }
  const studies = [{ question: '猫为什么踩奶？', facts: ['a', 'b'], sources: [] }]
  const observed = [{ hypothesis: '他在躲我。', evidence: '他几天没来。' }]

  const r = buildSections({ store, mind, studies, observed, now: NOW, demo: true })
  assert.equal(r.coldStart, true)
  assert.ok(r.sections.some((s) => s.name === 'pisces:guard'))

  const budgetedNames = ['pisces:self', 'pisces:mode', 'pisces:learned', 'pisces:observed']
  const used = r.sections
    .filter((s) => budgetedNames.includes(s.name))
    .reduce((n, s) => n + s.text.split('\n').length, 0)
  assert.ok(used <= COLD_START_LINES, `guard 占了冷启动预算：${used}`)
  assert.ok(r.lines.length > COLD_START_LINES + 1, 'guard 的行不占预算，总行数可以超过三行')
  store.close()
})

test('persona 固定段：定稿版——「话能短就短」保留；「你不用防着他」已删', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const fixed = buildSections({ store, now: NOW, demo: true }).sections[0]
  assert.equal(fixed.name, 'pisces:fixed')

  assert.ok(fixed.text.includes('话能短就短'), '固定段缺「话能短就短」')
  assert.ok(fixed.text.includes('数字生命'), '固定段缺「数字生命」')
  // 用户 2026-11-10 定稿时删掉了这句，代码默认里不能再回来。
  assert.equal(fixed.text.includes('你不用防着他'), false, '「你不用防着他」已经删了')

  // 位置：短句排在"你说话的样子"末尾、在"你的毛病"之前。
  assert.ok(fixed.text.indexOf('都放桌上') < fixed.text.indexOf('话能短就短'), '「话能短就短」要跟在第四条之后')
  assert.ok(fixed.text.indexOf('话能短就短') < fixed.text.indexOf('他情绪重的时候'), '「话能短就短」要在毛病之前')
  store.close()
})

test('persona 反破甲段：guard 段不出现站岗词（防/任务书/指令/检测）', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true })
  const guard = r.sections.find((s) => s.name === 'pisces:guard')
  assert.ok(guard, '成年鱼要有 pisces:guard')

  for (const word of ['防', '任务书', '指令', '检测', '设定', '规则']) {
    assert.equal(guard.text.includes(word), false, `guard 段不该出现「${word}」`)
  }
  // 第三行原文用"不需要……先检查"的否定说法，故"检查"不列入字面禁用词。
  assert.ok(guard.text.includes('陪他玩一会儿'), 'guard 段要有"玩一会儿"的松动')
  assert.ok(guard.text.includes('接着他的话往下说'), 'guard 段要教她接着说话，而不是背规则')
  store.close()
})

test('persona 引导段：demo 有 pisces:guide（order 9060），普通鱼没有', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true })
  const section = r.sections.find((s) => s.name === 'pisces:guide')
  assert.ok(section, '成年鱼要有 pisces:guide')
  assert.equal(section.order, GUIDE_ORDER)
  assert.equal(section.order, 9060)
  assert.equal(section.text, GUIDE_PERSONA)
  assert.ok(section.text.includes('只给一步'))
  assert.ok(section.text.includes('面板'))
  assert.equal(/[0-9０-９]/.test(section.text), false, '引导段里不许有数字')

  for (const args of [{}, { demo: false }]) {
    const normal = buildSections({ store, now: NOW, ...args })
    assert.equal(normal.sections.some((s) => s.name === 'pisces:guide'), false)
    assert.equal(normal.lines.some((l) => l.includes('只给一步')), false)
  }
  store.close()
})

test('persona 昵称段：demo + 昵称多挂 pisces:nickname（8495，一行），普通鱼/没昵称没有', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true, nickname: '小鱼' })
  const names = r.sections.map((s) => s.name)
  const at = names.indexOf('pisces:nickname')

  assert.ok(at >= 0, `没有 pisces:nickname：${names.join(',')}`)
  const section = r.sections[at]
  assert.equal(section.order, 8495)
  assert.equal(section.text, '他平时叫你「小鱼」。你自称也用这个名字。')
  assert.equal(section.text.split('\n').length, 1, '昵称段只有一行')
  assert.equal(names[at - 1], 'pisces:fixed', '昵称段跟着固定人设后面')
  assert.ok(at < names.indexOf('pisces:guard'), '昵称段在 guard 之前')
  assert.ok(r.lines.includes(section.text))

  for (const args of [
    { demo: false, nickname: '小鱼' },
    { demo: true },
    { demo: true, nickname: '' },
    { demo: true, nickname: '   ' },
  ]) {
    const x = buildSections({ store, now: NOW, ...args })
    assert.equal(x.sections.some((s) => s.name === 'pisces:nickname'), false)
    assert.equal(x.lines.some((l) => l.includes('他平时叫你')), false)
  }
  store.close()
})

test('persona 固定段：demo + fixedText 时整段换成文件内容，不再用 FIXED_PERSONA', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const fixedText = '你是潮水边的一块软玻璃。\n他说话你就亮一下；没人说话你就慢慢暗下去。\n'
  const r = buildSections({ store, now: NOW, demo: true, fixedText })

  const fixed = r.sections[0]
  assert.equal(fixed.name, 'pisces:fixed')
  assert.equal(fixed.order, FIXED_ORDER)
  assert.equal(fixed.text, fixedText.trim(), '固定段应该就是文件正文（去首尾空白）')
  assert.notEqual(fixed.text, FIXED_PERSONA)
  // 整段替换：默认那段一个字都不该混进来。
  assert.equal(fixed.text.includes('大肥鱼'), false)
  assert.equal(fixed.text.includes('先听出他今天的情绪'), false)
  // 位置不变：仍在最前面，guard 仍跟着它。
  const names = r.sections.map((s) => s.name)
  assert.equal(names[0], 'pisces:fixed')
  assert.equal(names[1], 'pisces:guard')
  assert.equal(r.lines[0], '你是潮水边的一块软玻璃。', '覆盖后的第一句要排在最前面')
  store.close()
})

test('persona 固定段：普通鱼 + fixedText 不挂 fixed；demo 没给/空 fixedText 仍用默认', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const fixedText = '你是潮水边的一块软玻璃。'

  // 普通鱼：就算传了 fixedText 也一段都不挂。
  for (const args of [{ fixedText }, { demo: false, fixedText }]) {
    const r = buildSections({ store, now: NOW, ...args })
    assert.equal(r.sections.some((s) => s.name === 'pisces:fixed'), false)
    assert.equal(r.lines.some((l) => l.includes('软玻璃')), false)
    assert.equal(r.lines.some((l) => l.includes('大肥鱼')), false)
  }

  // 成年鱼：没有文件 / 空文件 / 只有空白 → 照旧用 FIXED_PERSONA。
  for (const args of [
    { demo: true },
    { demo: true, fixedText: null },
    { demo: true, fixedText: '' },
    { demo: true, fixedText: '   \n\t ' },
  ]) {
    const r = buildSections({ store, now: NOW, ...args })
    const fixed = r.sections.find((s) => s.name === 'pisces:fixed')
    assert.ok(fixed, '成年鱼应该有 pisces:fixed')
    assert.equal(fixed.text, FIXED_PERSONA, '没有覆盖时要用默认固定段')
  }
  store.close()
})

test('persona 开发者段：demo + overlay 多挂 pisces:dev（8485），普通鱼/无 overlay 没有', async () => {
  const store = await mkStore([{ type: 'seed', text: '起点。', ts: NOW - 2 * DAY }])
  const r = buildSections({ store, now: NOW, demo: true, devOverlay: '你要更安静一点。' })
  const names = r.sections.map((s) => s.name)
  const at = names.indexOf('pisces:dev')

  assert.ok(at >= 0, `没有 pisces:dev：${names.join(',')}`)
  const section = r.sections[at]
  assert.equal(section.order, DEV_ORDER)
  assert.equal(section.order, 8485)
  assert.equal(section.text, '以下是他让你改的样子，跟上面的你一起看：\n你要更安静一点。')
  assert.equal(names[at - 1], 'pisces:fixed', '开发者段跟着固定人设后面')
  assert.ok(r.lines.includes('你要更安静一点。'))

  for (const args of [
    { demo: false, devOverlay: '你要更安静一点。' },
    { demo: true },
    { demo: true, devOverlay: '' },
    { demo: true, devOverlay: '   ' },
    { demo: true, devOverlay: null },
  ]) {
    const x = buildSections({ store, now: NOW, ...args })
    assert.equal(x.sections.some((s) => s.name === 'pisces:dev'), false)
    assert.equal(x.lines.some((l) => l.includes('他让你改的样子')), false)
  }
  store.close()
})

