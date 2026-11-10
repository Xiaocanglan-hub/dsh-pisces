// voice.js —— 语音回复（条件触发，默认休眠）。
//
// 三条口径：
// 1. 只在「用户用语音说话」时回语音：`isVoiceInput` 认 `input.voice` / parts 里的
//    audio|voice / `audio/*` 的 mediaType；他打字就只回文字。
// 2. 没有适配器就完全静默：`detectAdapter` 回 `{ok:false}`，不抛、不写事件、不占面板；
//    现在宿主里没有 TTS 服务，所以默认就是休眠。
// 3. 命令适配器不经过 shell：`command` 拆成参数数组，`{text}` / `{out}` / `{voice}`
//    分别替换成单个 argv，文本永远不拼进 shell 字符串；超时就杀掉。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 合成出来的文件放 `<root>/voice/`。 */
export const VOICE_DIR = 'voice'
/** 隐藏配置：`<root>/voice.json`，不进 settings 面板。 */
export const VOICE_CONFIG = 'voice.json'
export const DEFAULT_TIMEOUT_MS = 20_000

const MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  flac: 'audio/flac',
  webm: 'audio/webm',
}

function errText(e) {
  return String(e?.message ?? e ?? '未知错误')
}

function normalizeFormat(format) {
  const s = String(format ?? '').toLowerCase().replace(/^\./, '')
  return /^[a-z0-9]{1,8}$/.test(s) ? s : 'mp3'
}

export function mimeOf(format) {
  return MIME[normalizeFormat(format)] || 'application/octet-stream'
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 读隐藏配置 `<root>/voice.json`：
 *   { enabled, adapter, command, voice, format, timeoutMs }
 * 文件不存在 / 坏 JSON / 不是对象都回 null；没给 command 也回对象（service 适配器只需要 enabled）。
 */
export function loadVoiceConfig(root) {
  if (!root) return null
  let raw
  try {
    const text = fs.readFileSync(path.join(String(root), VOICE_CONFIG), 'utf8').replace(/^\uFEFF/, '')
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(raw)) return null
  const timeout = Number(raw.timeoutMs)
  return {
    enabled: raw.enabled !== false,
    adapter: raw.adapter === 'service' || raw.adapter === 'command' ? raw.adapter : null,
    command: typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : null,
    voice: typeof raw.voice === 'string' && raw.voice.trim() ? raw.voice.trim() : null,
    format: normalizeFormat(raw.format),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  }
}

/** 把命令串拆成 argv：支持单/双引号，引号内只把 \" 和 \\ 当转义；不经过 shell。 */
export function splitCommand(command) {
  const out = []
  let cur = ''
  let quote = null
  let touched = false
  const text = String(command ?? '')
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        cur += text[i + 1]
        i += 1
        continue
      }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      touched = true
      continue
    }
    if (/\s/.test(ch)) {
      if (touched || cur) {
        out.push(cur)
        cur = ''
        touched = false
      }
      continue
    }
    cur += ch
  }
  if (touched || cur) out.push(cur)
  return out
}

function fillToken(token, { text, out, voice }) {
  let s = token.split('{text}').join(text)
  s = s.split('{out}').join(out)
  if (voice) s = s.split('{voice}').join(voice)
  return s
}

/** 跑本地命令：参数数组、无 shell、超时杀进程。成功与否由调用方看输出文件。 */
function runCommand(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const done = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: 'ignore', shell: false })
    } catch (e) {
      done({ ok: false, reason: `命令起不来：${errText(e)}` })
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      done({ ok: false, reason: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.once('error', (e) => done({ ok: false, reason: `命令跑不起来：${errText(e)}` }))
    child.once('close', (code, signal) => done({ ok: true, code, signal }))
  })
}

function commandAdapter(config) {
  const tokens = splitCommand(config.command)
  const bin = tokens[0]
  const argsTemplate = tokens.slice(1)
  const hasText = tokens.some((t) => t.includes('{text}'))
  const hasOut = tokens.some((t) => t.includes('{out}'))
  if (!bin) return { ok: false, reason: 'voice.json 的 command 是空的' }
  if (!hasOut) return { ok: false, reason: 'voice.json 的 command 里没有 {out} 占位' }

  async function synthesize(text, opts = {}) {
    const out = typeof opts?.out === 'string' && opts.out ? opts.out : ''
    if (!out) return { ok: false, reason: '没有输出文件路径' }
    const args = argsTemplate.map((t) => fillToken(t, { text, out, voice: config.voice }))
    // 没写 {text} 时把正文作为最后一个独立参数，仍然不经过 shell。
    if (!hasText) args.push(text)
    const ran = await runCommand(bin, args, config.timeoutMs)
    if (!ran.ok) return ran
    let bytes = 0
    try {
      bytes = fs.statSync(out).size
    } catch {
      bytes = 0
    }
    if (!bytes) return { ok: false, reason: `没生成音频（退出码 ${ran.code ?? '?'}）` }
    return { ok: true, file: out, mime: mimeOf(config.format) }
  }

  return {
    ok: true,
    kind: 'command',
    describe: `command:${bin}`,
    synthesize,
  }
}

function serviceAdapter(svc, config) {
  async function synthesize(text, opts = {}) {
    // 服务返回 {audio: Buffer|Uint8Array, mime?} 或 {file}；失败原样透传 reason。
    let r
    try {
      r = await svc.synthesize(text, { format: opts?.format || config?.format || 'mp3', voice: config?.voice ?? undefined, out: opts?.out })
    } catch (e) {
      return { ok: false, reason: `服务合成失败：${errText(e)}` }
    }
    if (r?.ok === false) return { ok: false, reason: String(r.reason || '服务合成失败') }
    if (r?.audio != null) return { ok: true, audio: r.audio, mime: r.mime || mimeOf(opts?.format || 'mp3') }
    if (typeof r?.file === 'string' && r.file) return { ok: true, file: r.file, mime: r.mime || mimeOf(opts?.format || 'mp3') }
    return { ok: false, reason: '服务没有返回 audio/file' }
  }

  return {
    ok: true,
    kind: 'service',
    describe: 'service:voice',
    synthesize,
  }
}

/** 单次探测：任何一步抛错都只当「没有这个服务」，异常绝不冒出去。 */
function probe(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

/** 服务得先有 `synthesize` 才算数；连取这个属性都可能抛（getter/Proxy）。 */
function synthesizeOf(svc) {
  return probe(() => (svc && typeof svc.synthesize === 'function' ? svc : null))
}

/**
 * 找宿主里的 TTS 服务：`ctx.get('voice')`、`ctx.get('tts')`、`ctx.voice`、`ctx.tts`
 * **逐个探测、各自 try**。宿主（cordis Context / Proxy）取未知服务时可能抛错，
 * 之前的写法只有 `ctx.get` 在 try 里、属性探测裸奔，一抛就把 detectAdapter 整个
 * 掀翻，连 voice.json 的 command 分支都到不了。任一探测抛错 = 没有该服务，继续下一个。
 */
function serviceOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return null
  const fromGet = (name) => probe(() => (typeof ctx.get === 'function' ? ctx.get(name) : null))
  const fromProp = (name) => probe(() => ctx[name])
  for (const name of ['voice', 'tts']) {
    const svc = synthesizeOf(fromGet(name))
    if (svc) return svc
  }
  for (const name of ['voice', 'tts']) {
    const svc = synthesizeOf(fromProp(name))
    if (svc) return svc
  }
  return null
}

/**
 * 找适配器：显式 `adapter:'command'` 或 ctx 里没有服务时用 voice.json 的 command；
 * 否则优先用 `ctx.get('voice') ?? ctx.get('tts')`。全部失败回 `{ok:false, reason}`，不抛。
 */
export function detectAdapter({ ctx = null, root = null } = {}) {
  const config = loadVoiceConfig(root)
  if (config && config.enabled === false) return { ok: false, reason: 'voice.json 里 enabled:false（休眠）' }
  const svc = serviceOf(ctx)
  const forceCommand = config?.adapter === 'command'
  if (forceCommand && config?.command) return commandAdapter(config)
  if (svc) return serviceAdapter(svc, config)
  if (config?.command) return commandAdapter(config)
  return { ok: false, reason: '没有语音适配器（休眠）' }
}

function audioish(v) {
  return typeof v === 'string' && /^audio\//i.test(v)
}

/** 一条用户消息是不是语音：voice:true / parts 里的 audio|voice / mediaType 是 audio/*。 */
export function isVoiceInput(input) {
  if (!input || typeof input !== 'object') return false
  if (input.voice === true) return true
  if (audioish(input.mediaType) || audioish(input.mimeType) || audioish(input.mime)) return true
  if (input.type === 'audio' || input.type === 'voice') return true
  if (input.media && typeof input.media === 'object') {
    if (audioish(input.media.mediaType) || audioish(input.media.mimeType) || audioish(input.media.mime)) return true
  }
  const parts = Array.isArray(input.parts) ? input.parts : Array.isArray(input.content) ? input.content : []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'audio' || part.type === 'voice') return true
    if (audioish(part.mediaType) || audioish(part.mimeType) || audioish(part.mime)) return true
  }
  return false
}

/** 三条同时成立才回语音：有可用适配器、开关没关、这条消息是语音。 */
export function shouldReplyWithVoice({ adapter, input, enabled = true } = {}) {
  return Boolean(adapter && adapter.ok === true && enabled !== false && isVoiceInput(input))
}

function asBuffer(audio) {
  if (Buffer.isBuffer(audio)) return audio
  if (audio instanceof Uint8Array) return Buffer.from(audio)
  if (audio instanceof ArrayBuffer) return Buffer.from(new Uint8Array(audio))
  return null
}

/**
 * 合成到文件：`outDir/reply-<ts>.<format>`，写完 stat 一次校验字节数。
 * 任何失败都回 `{ok:false, reason}`，不抛。
 */
export async function synthesizeToFile({ adapter, text, outDir, format = 'mp3' } = {}) {
  try {
    if (!adapter || adapter.ok !== true || typeof adapter.synthesize !== 'function') {
      return { ok: false, reason: '没有语音适配器（休眠）' }
    }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: '没有要念的文字' }
    if (typeof outDir !== 'string' || !outDir.trim()) return { ok: false, reason: '没有输出目录' }

    const dir = path.resolve(outDir)
    fs.mkdirSync(dir, { recursive: true })
    const fmt = normalizeFormat(format)
    const stamp = Date.now()
    let file = path.join(dir, `reply-${stamp}.${fmt}`)
    for (let i = 1; fs.existsSync(file); i += 1) {
      file = path.join(dir, `reply-${stamp}-${i}.${fmt}`)
    }

    const r = await adapter.synthesize(text, { out: file, format: fmt })
    if (r?.ok === false) return { ok: false, reason: String(r.reason || '合成失败') }

    let mime = r?.mime || mimeOf(fmt)
    if (r?.audio != null) {
      const buf = asBuffer(r.audio)
      if (!buf || !buf.length) return { ok: false, reason: '音频是空字节' }
      fs.writeFileSync(file, buf)
    } else if (typeof r?.file === 'string' && r.file) {
      if (path.resolve(r.file) !== file) fs.copyFileSync(r.file, file)
    } else {
      return { ok: false, reason: '适配器没有给音频' }
    }

    const st = fs.statSync(file)
    if (!st.size) return { ok: false, reason: '音频是 0 字节' }
    return { ok: true, file, mime, bytes: st.size }
  } catch (e) {
    return { ok: false, reason: `合成失败：${errText(e)}` }
  }
}
