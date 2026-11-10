// voice（语音回复）：条件触发、默认休眠。不碰宿主、不发网络请求。
//
// 覆盖的硬口径：
// - 没有 ctx / voice.json 就休眠，detectAdapter 回 {ok:false} 且不抛；
// - 命令适配器不经过 shell：{text}/{out} 各替换成一个 argv，成功看输出文件；
// - 超时杀进程、合成失败/适配器抛错都只回 {ok:false, reason}；
// - 只有「有适配器 + 语音输入 + 开关开」三条同时成立才回语音。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  detectAdapter,
  isVoiceInput,
  loadVoiceConfig,
  shouldReplyWithVoice,
  splitCommand,
  synthesizeToFile,
  VOICE_DIR,
} from '../lib/voice.js'

function mkRoot(tag = 'voice') {
  return mkdtempSync(path.join(tmpdir(), `pisces-${tag}-`))
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用，留着也不影响断言 */
  }
}

/** 命令串里带空格的路径用双引号包起来；JSON.stringify 顺带处理反斜杠转义。 */
const q = (s) => JSON.stringify(String(s))

function writeScript(root, body, name = 'fake-tts.cjs') {
  const file = path.join(root, name)
  writeFileSync(file, body, 'utf8')
  return file
}

function writeCmdConfig(root, command, extra = {}) {
  const cfg = { enabled: true, command, timeoutMs: 5000, ...extra }
  writeFileSync(path.join(root, 'voice.json'), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

const WRITE_SCRIPT = `
const fs = require('node:fs')
const out = process.argv[2]
const text = process.argv[3] || ''
fs.writeFileSync(out, 'FAKE:' + text, 'utf8')
`

const SLEEP_SCRIPT = `
const fs = require('node:fs')
setTimeout(() => {
  try { fs.writeFileSync(process.argv[2], 'late', 'utf8') } catch {}
}, 5000)
`

test('voice：没有 ctx、也没有 voice.json → detectAdapter 回 {ok:false}', () => {
  const root = mkRoot()
  try {
    assert.equal(loadVoiceConfig(root), null)
    const a = detectAdapter({ root })
    assert.equal(a.ok, false)
    assert.equal(typeof a.reason, 'string')
    const b = detectAdapter()
    assert.equal(b.ok, false)
  } finally {
    cleanup(root)
  }
})

test('voice：voice.json 的 command 指向本地假脚本 → detectAdapter 成功', () => {
  const root = mkRoot()
  try {
    const script = writeScript(root, WRITE_SCRIPT)
    const command = `${q(process.execPath)} ${q(script)} {out} {text}`
    writeCmdConfig(root, command, { voice: 'zh-CN-XiaoxiaoNeural', timeoutMs: 8000 })

    const cfg = loadVoiceConfig(root)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.command, command)
    assert.equal(cfg.voice, 'zh-CN-XiaoxiaoNeural')
    assert.equal(cfg.timeoutMs, 8000)
    assert.equal(cfg.format, 'mp3')

    const a = detectAdapter({ root })
    assert.equal(a.ok, true)
    assert.equal(a.kind, 'command')
    assert.match(a.describe, /command:/)
    assert.deepEqual(splitCommand(command).slice(0, 2), [process.execPath, script])
  } finally {
    cleanup(root)
  }
})

test('voice：命令适配器 synthesizeToFile 真的落文件、bytes>0（{text} 不被 shell 拆开）', async () => {
  const root = mkRoot()
  try {
    const script = writeScript(root, WRITE_SCRIPT)
    writeCmdConfig(root, `${q(process.execPath)} ${q(script)} {out} {text}`)
    const adapter = detectAdapter({ root })
    assert.equal(adapter.ok, true)

    const text = '你好，世界 这里有空格'
    const outDir = path.join(root, VOICE_DIR)
    const r = await synthesizeToFile({ adapter, text, outDir })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.bytes > 0, true)
    assert.equal(r.mime, 'audio/mpeg')
    assert.equal(existsSync(r.file), true)
    assert.equal(path.dirname(r.file), outDir)
    assert.match(path.basename(r.file), /^reply-\d+\.mp3$/)
    assert.equal(statSync(r.file).size, r.bytes)
    assert.equal(readFileSync(r.file, 'utf8'), `FAKE:${text}`)
  } finally {
    cleanup(root)
  }
})

test('voice：命令超过 timeoutMs 被杀 → {ok:false}，测试不挂', async () => {
  const root = mkRoot()
  try {
    const script = writeScript(root, SLEEP_SCRIPT)
    writeCmdConfig(root, `${q(process.execPath)} ${q(script)} {out}`, { timeoutMs: 150 })
    const adapter = detectAdapter({ root })
    assert.equal(adapter.ok, true)

    const started = Date.now()
    const r = await synthesizeToFile({ adapter, text: '这条应该超时', outDir: path.join(root, VOICE_DIR) })
    assert.equal(r.ok, false)
    assert.match(r.reason, /超时|没生成/)
    assert.equal(Date.now() - started < 4000, true, '超时应该很快被杀')
  } finally {
    cleanup(root)
  }
})

test('voice：isVoiceInput 认 voice:true / parts 里的 audio / audio/*，纯文字 false', () => {
  assert.equal(isVoiceInput({ voice: true }), true)
  assert.equal(isVoiceInput({ parts: [{ type: 'audio' }] }), true)
  assert.equal(isVoiceInput({ parts: [{ type: 'voice', mediaType: 'audio/ogg' }] }), true)
  assert.equal(isVoiceInput({ mediaType: 'audio/mpeg' }), true)
  assert.equal(isVoiceInput({ text: '你好' }), false)
  assert.equal(isVoiceInput({ parts: [{ type: 'text', text: '你好' }] }), false)
  assert.equal(isVoiceInput(null), false)
})

test('voice：shouldReplyWithVoice 三条同时成立才 true', () => {
  const adapter = { ok: true, kind: 'service' }
  assert.equal(shouldReplyWithVoice({ adapter, input: { voice: true } }), true)
  assert.equal(shouldReplyWithVoice({ adapter, input: { text: '打字' } }), false)
  assert.equal(shouldReplyWithVoice({ adapter, input: { voice: true }, enabled: false }), false)
  assert.equal(shouldReplyWithVoice({ adapter: null, input: { voice: true } }), false)
})

test('voice：假 service adapter 返回 Buffer → 落文件、mime 正确；ctx 里的 voice 也能被识别', async () => {
  const root = mkRoot()
  try {
    const outDir = path.join(root, VOICE_DIR)
    const audio = Buffer.from([1, 2, 3, 4, 5])
    const adapter = {
      ok: true,
      kind: 'service',
      synthesize: async () => ({ audio, mime: 'audio/mpeg' }),
    }
    const r = await synthesizeToFile({ adapter, text: '服务合成的', outDir })
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.mime, 'audio/mpeg')
    assert.equal(r.bytes, audio.length)
    assert.deepEqual(readFileSync(r.file), audio)

    // ctx.get('voice') 有 synthesize 时，detectAdapter 走 service。
    const svc = { synthesize: async () => ({ audio: Buffer.from('abc') }) }
    const detected = detectAdapter({ ctx: { get: (name) => (name === 'voice' ? svc : null) } })
    assert.equal(detected.ok, true)
    assert.equal(detected.kind, 'service')
    const r2 = await synthesizeToFile({ adapter: detected, text: '再来', outDir })
    assert.equal(r2.ok, true, r2.reason)
    assert.equal(r2.bytes, 3)
  } finally {
    cleanup(root)
  }
})

test('voice：适配器抛错（同步/异步）→ {ok:false, reason}，不崩', async () => {
  const root = mkRoot()
  try {
    const outDir = path.join(root, VOICE_DIR)
    const syncThrow = {
      ok: true,
      kind: 'service',
      synthesize() {
        throw new Error('boom-sync')
      },
    }
    const a = await synthesizeToFile({ adapter: syncThrow, text: '炸一下', outDir })
    assert.equal(a.ok, false)
    assert.match(a.reason, /boom-sync/)

    const asyncThrow = {
      ok: true,
      kind: 'service',
      synthesize: async () => {
        throw new Error('boom-async')
      },
    }
    const b = await synthesizeToFile({ adapter: asyncThrow, text: '再炸一下', outDir })
    assert.equal(b.ok, false)
    assert.match(b.reason, /boom-async/)
  } finally {
    cleanup(root)
  }
})

// 真机回归：宿主的 ctx（cordis Context / Proxy）取未知服务会抛错。旧代码只有 ctx.get
// 在 try 里、ctx[key] 属性探测裸奔，异常在走到 command 分支之前就冒到 index.js 的 catch
// 里被吞掉，于是「有 voice.json 的 command」在真机上也像没有适配器。
test('voice：ctx.get 抛错 + voice.json 有 command → 仍 {ok:true,kind:"command"}', () => {
  const root = mkRoot()
  try {
    const script = writeScript(root, WRITE_SCRIPT)
    writeCmdConfig(root, `${q(process.execPath)} ${q(script)} {out} {text}`)

    // 1) 普通对象，只有 get 抛错。
    const getThrows = {
      get() {
        throw new Error('service voice is not injected')
      },
    }
    const a = detectAdapter({ ctx: getThrows, root })
    assert.equal(a.ok, true)
    assert.equal(a.kind, 'command')

    // 2) 宿主式 ctx：连 ctx[key] 属性探测都抛错（旧代码就是在这里漏的异常）。
    const hostile = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === 'get') {
            return () => {
              throw new Error('service voice is not injected')
            }
          }
          throw new Error(`unknown ctx member: ${String(key)}`)
        },
      },
    )
    const b = detectAdapter({ ctx: hostile, root })
    assert.equal(b.ok, true)
    assert.equal(b.kind, 'command')
  } finally {
    cleanup(root)
  }
})

test('voice：ctx 返回的服务上 synthesize 抛错 → 不崩；无 command 回 {ok:false}，有 command 走 command', async () => {
  const root = mkRoot()
  try {
    // synthesize 是抛错的 getter：取它就算探测失败 → 当没有这个服务。
    const badSvc = {
      get synthesize() {
        throw new Error('boom-getter')
      },
    }
    const ctxGet = { get: (name) => (name === 'voice' ? badSvc : null) }

    const a = detectAdapter({ ctx: ctxGet })
    assert.equal(a.ok, false)
    assert.equal(typeof a.reason, 'string')

    const script = writeScript(root, WRITE_SCRIPT)
    writeCmdConfig(root, `${q(process.execPath)} ${q(script)} {out} {text}`)
    const b = detectAdapter({ ctx: ctxGet, root })
    assert.equal(b.ok, true)
    assert.equal(b.kind, 'command')

    // 服务能识别、但合成时才炸：detectAdapter 正常接 service，合成只回 {ok:false}。
    const callThrows = {
      synthesize: async () => {
        throw new Error('boom-call')
      },
    }
    const c = detectAdapter({ ctx: { get: (name) => (name === 'voice' ? callThrows : null) } })
    assert.equal(c.ok, true)
    assert.equal(c.kind, 'service')
    const r = await synthesizeToFile({ adapter: c, text: '念一下', outDir: path.join(root, VOICE_DIR) })
    assert.equal(r.ok, false)
    assert.match(r.reason, /boom-call/)
  } finally {
    cleanup(root)
  }
})
