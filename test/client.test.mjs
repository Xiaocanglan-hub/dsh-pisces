// client.js（设置段）：只解析 bundle + 假 ctx，不启动浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(HERE, '..', 'client.js')
const SRC = readFileSync(FILE, 'utf8')

/** 把 bundle 挂在假 window 上，返回入口与 factory 的返回值。 */
function loadBundle() {
  const loaded = []
  const fakeWindow = {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
      },
    },
  }
  new Function('window', SRC)(fakeWindow)
  assert.equal(loaded.length, 1, 'bundle 应该只调用一次 __ModuleLoader__.load')
  const entry = loaded[0]
  const fakeReact = {
    createElement: () => null,
    Fragment: function Fragment() {},
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const mod = entry.factory((id) => {
    assert.equal(id, 'react', '客户端只能 require react')
    return fakeReact
  })
  return { entry, mod }
}

test('bundle 能被 new Function 解析，id 是 dsh-pisces-core', () => {
  const { entry } = loadBundle()
  assert.equal(entry.id, 'dsh-pisces-core')
  assert.equal(typeof entry.factory, 'function')
})

test('factory 返回的对象有 inject:["slots"]（n22 的坑）', () => {
  const { mod } = loadBundle()
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.Panel, 'function')
})

test('apply 只注册一次 settings.section，标题是「派希丝」', () => {
  const { mod } = loadBundle()
  const effectLabels = []
  const injects = []
  const registers = []
  const ctx = {
    effect(fn, label) {
      effectLabels.push(label)
      return fn()
    },
    slots: {
      inject(name, cb, label) {
        injects.push({ name, label })
        return cb()
      },
      register(options, component) {
        registers.push({ options, component })
        return () => {}
      },
    },
  }

  mod.apply(ctx)

  assert.equal(effectLabels.length, 1)
  assert.equal(effectLabels[0], 'dsh-pisces: settings section')
  assert.deepEqual(injects.map((x) => x.name), ['settings.section'])
  assert.equal(registers.length, 1)
  assert.equal(registers[0].options.name, 'settings.section')
  assert.equal(registers[0].options.id, 'dsh-pisces')
  assert.equal(registers[0].options.order, 70)
  assert.equal(registers[0].options.label(), '派希丝')
  assert.equal(registers[0].component, mod.Panel)

  // 宿主现行签名是 slots.inject + slots.register（参考文档 §1.3 / ui-settings 同形）。
  assert.match(SRC, /ctx\.slots\.inject\(/)
  assert.match(SRC, /ctx\.slots\.register\(/)
})

test('六个页签的标签都在，「鸣谢」排在「反馈」之后', () => {
  const { mod } = loadBundle()
  assert.deepEqual(
    mod.TABS.map((t) => t.label),
    ['状态', '设置', '心理活动', '原理', '反馈', '鸣谢'],
  )
})

test('鸣谢页：八个借鉴来源的名头与关键文案都在源码里（语音声线不进鸣谢）', () => {
  for (const word of [
    '鸣谢',
    'dsh-fish',
    'dsh-fish-memory',
    'Character Card V2',
    'dsh-companion',
    'Generative Agents',
    'DeepSeek Harness',
    '双鱼座',
    '所有养过鱼的人',
  ]) {
    assert.ok(SRC.includes(word), `client.js 鸣谢页缺「${word}」`)
  }
  for (const word of ['Xiaoxiao', 'edge-tts']) {
    assert.ok(!SRC.includes(word), `client.js 不该出现「${word}」（语音声线不进鸣谢）`)
  }
  // 隐藏项目不鸣谢。
  assert.ok(!SRC.includes('dsh-purge'), 'client.js 鸣谢页不该出现「dsh-purge」（隐藏项目不鸣谢）')
  // 自己的前作不用谢：作者自己的插件一个都不列。
  for (const word of ['dsh-whale-memory', 'dsh-memory-brain', 'dsh-school', 'dsh-slow-wave', 'dafeiyu_persona_core']) {
    assert.ok(!SRC.includes(word), `client.js 不该出现「${word}」（用户自己的插件不鸣谢）`)
  }
  // 没实现的机制不列：流水层、DUMA/双流、语病注入。
  assert.ok(!SRC.includes('dsh-fish-river'), 'client.js 不该出现「dsh-fish-river」（流水层没实现）')
  assert.ok(!SRC.includes('DUMA'), 'client.js 不该出现「DUMA」（机制不符）')
  // 底部那行小字，指向反馈页的加群方式。
  assert.ok(SRC.includes('发反馈告诉我们'), '鸣谢页底部小字没写')
})

test('鸣谢八条顺序固定：dsh-fish 排第一', () => {
  const { mod } = loadBundle()
  assert.deepEqual(
    mod.THANKS.map((t) => t.name),
    [
      'dsh-fish',
      'dsh-fish-memory',
      'Character Card V2',
      'dsh-companion',
      'Generative Agents',
      'DeepSeek Harness',
      '双鱼座性格的公开资料',
      '所有养过鱼的人',
    ],
  )
  assert.equal(mod.THANKS.length, 8, '鸣谢应该正好八条')
})

test('源码没有禁止的词，也没有 range 输入', () => {
  assert.doesNotMatch(SRC, /性格滑条|好感度|亲密度/)
  assert.doesNotMatch(SRC, /type:\s*['"]range['"]/)
  assert.doesNotMatch(SRC, /<input\b/i)
})

test('设置页不露出开发者钥匙：源码里没有面板相关的字样，也不调用 /devkey', () => {
  for (const word of ['开发者钥匙', '生成钥匙', '重置钥匙']) {
    assert.ok(!SRC.includes(word), `client.js 不该出现「${word}」`)
  }
  assert.doesNotMatch(SRC, /\/devkey/)
})

test('空状态文案存在（还没有）', () => {
  const empties = SRC.match(/还没有/g) || []
  assert.ok(empties.length >= 4, `空状态文案太少：${empties.length}`)
})

test('文件行数不超过 1100（防止又长成巨石文件）', () => {
  const lines = SRC.split(/\r?\n/).length
  assert.ok(lines <= 1100, `client.js 现在 ${lines} 行`)
})

test('不 import 宿主包，只 require react', () => {
  assert.doesNotMatch(SRC, /@deepseek-ai\//)
  assert.match(SRC, /require\(['"]react['"]\)/)
})
