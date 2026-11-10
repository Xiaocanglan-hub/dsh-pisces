// settings（设置中心）：settings.json 的读写、schema 校验、启动期合并。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULTS,
  SCHEMA,
  mergeConfig,
  readSettings,
  settingsPath,
  writeSettings,
} from '../lib/settings.js'

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-settings-'))
}

test('没有 settings.json：readSettings 回一份 DEFAULTS，路径在数据根下', () => {
  const root = mkRoot()
  assert.equal(settingsPath(root), path.join(root, 'settings.json'))
  assert.deepEqual(readSettings(root), DEFAULTS)
  assert.equal(existsSync(settingsPath(root)), false)
  // 反破甲默认开，但它是隐藏项：不进面板 schema。
  assert.equal(DEFAULTS.persona.guard, true)
  assert.equal(SCHEMA.some((s) => s.path === 'persona.guard'), false)
})

test('坏 JSON / 不是对象：也回 DEFAULTS，不抛', () => {
  const root = mkRoot()
  writeFileSync(settingsPath(root), '{ 这不是 json', 'utf8')
  assert.deepEqual(readSettings(root), DEFAULTS)

  writeFileSync(settingsPath(root), '[1,2,3]', 'utf8')
  assert.deepEqual(readSettings(root), DEFAULTS)
})

test('写 bool/enum 成功并落盘（0600）；DEFAULTS 里没改的键保持原样', () => {
  const root = mkRoot()
  const r = writeSettings(root, { tools: { narrow: true }, dual: { mode: 'B' } })

  assert.equal(r.ok, true)
  assert.equal(r.settings.tools.narrow, true)
  assert.equal(r.settings.dual.mode, 'B')
  assert.equal(r.settings.dual.enabled, false, '没写的键还是默认')
  assert.equal(r.settings.persona.attach, true, '没写的组还是默认')
  assert.ok(r.changed.includes('tools.narrow'))
  assert.ok(r.changed.includes('dual.mode'))

  const file = settingsPath(root)
  assert.equal(existsSync(file), true)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.tools.narrow, true)
  assert.equal(saved.dual.mode, 'B')
  assert.deepEqual(readSettings(root), r.settings)

  const mode = statSync(file).mode & 0o777
  if (process.platform === 'win32') {
    // Windows 不保留 POSIX 位：Node 一律报 0666。这里至少证明文件不是只读。
    assert.equal(mode & 0o200, 0o200, `Windows 上文件应该可写，实际 ${mode.toString(8)}`)
  } else {
    assert.equal(mode, 0o600)
  }
})

test('未知 path 拒绝（整次不写盘）', () => {
  const root = mkRoot()
  const r = writeSettings(root, { tools: { nope: true } })

  assert.equal(r.ok, false)
  assert.match(r.reason, /tools\.nope/)
  assert.deepEqual(r.changed, [])
  assert.equal(existsSync(settingsPath(root)), false, '被拒绝时不该留下文件')
})

test('错误类型拒绝：bool 只收 true/false、enum 只收 options', () => {
  const root = mkRoot()
  const badBool = writeSettings(root, { tools: { narrow: 'yes' } })
  assert.equal(badBool.ok, false)
  assert.match(badBool.reason, /true \/ false/)

  const badEnum = writeSettings(root, { dual: { mode: 'Z' } })
  assert.equal(badEnum.ok, false)
  assert.match(badEnum.reason, /A \/ B|A \/ B/)

  const badPatch = writeSettings(root, 'tools.narrow=true')
  assert.equal(badPatch.ok, false)
  assert.match(badPatch.reason, /对象/)
  assert.equal(existsSync(settingsPath(root)), false)
})

test('bili.qrLogin 只读：写入被忽略并提示，磁盘上仍是 idle', () => {
  const root = mkRoot()
  const r = writeSettings(root, { bili: { qrLogin: 'logged-in' } })

  assert.equal(r.ok, true)
  assert.deepEqual(r.changed, [])
  assert.deepEqual(r.needsRestart, [])
  assert.equal(r.settings.bili.qrLogin, 'idle')
  assert.match(r.note, /只读/)
  assert.equal(readSettings(root).bili.qrLogin, 'idle')

  // persona.guard 是隐藏项：写入静默丢弃，不报错、不提示、磁盘上仍是默认 true。
  const guard = writeSettings(root, { persona: { guard: false } })
  assert.equal(guard.ok, true)
  assert.deepEqual(guard.changed, [])
  assert.deepEqual(guard.needsRestart, [])
  assert.equal(guard.note, undefined)
  assert.equal(readSettings(root).persona.guard, true)
})

test('mergeConfig：宿主 config 不被 settings/DEFAULTS 抹掉（逐键宿主优先）', () => {
  const host = {
    tools: false,
    foo: 'bar',
    dual: { enabled: true, custom: 'x' },
    persona: { guard: false },
  }
  const settings = { dual: { enabled: false, mode: 'B' }, bili: { speak: false } }
  const m = mergeConfig(host, settings)

  assert.equal(m.tools, false, '非对象逃生口原样保留')
  assert.equal(m.foo, 'bar', 'DEFAULTS 没有的宿主键原样保留')
  assert.equal(m.dual.enabled, true, '宿主对象里的键优先')
  assert.equal(m.dual.mode, 'B', '宿主没写的键仍可由 settings 覆盖默认')
  assert.equal(m.dual.custom, 'x', '宿主对象里多出来的键不丢')
  assert.equal(m.persona.guard, false)
  assert.equal(m.persona.attach, true)
  assert.equal(m.bili.speak, false)
  assert.equal(m.bili.qrLogin, 'idle')

  assert.deepEqual(mergeConfig(null, null), DEFAULTS)
})

test('needsRestart 只含 SCHEMA 里 restart:true 的项', () => {
  const root = mkRoot()
  const r = writeSettings(root, { tools: { narrow: true }, panel: { affinity: false }, dual: { mode: 'B' } })

  assert.equal(r.ok, true)
  assert.ok(r.changed.includes('tools.narrow'))
  assert.ok(r.changed.includes('panel.affinity'))
  assert.ok(r.changed.includes('dual.mode'))
  assert.deepEqual(r.needsRestart, ['tools.narrow', 'dual.mode'], '面板项不重启，工具/双流要重启')
  for (const p of r.needsRestart) {
    assert.equal(SCHEMA.find((s) => s.path === p)?.restart, true, `${p} 不该标重启`)
  }
  assert.equal(readSettings(root).panel.affinity, false)
})
