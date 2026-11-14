// dsh-pisces-core：把 lib/ 里的东西装配成一个 DSH 插件。
//
// 装配口径（知识库 n5 / n28 / n42，README 的「在真实宿主里验证」「工具面」「观测台」）：
// 1. 启动期宿主可能先 dispose 一次，所以 createStore 完成后必须检查 closed；关了就回收
//    store、释放锁、ready 解析成 null。
// 2. ready 一旦是 null 就永久是 null；工具面/服务不能把它钉死。所有服务方法都走 live()，
//    没有库就 ensureLive() 按需重开——停用之后观测台和工具照样能用。
// 3. 工具面放在 ready.then 里注册：演示标记要等库打开才知道；getStore 必须给 live()。
// 4. 观测台的 deps 里，seed/writeSeed/adopt/learn/verify 是 service 方法本身（闭包持库），
//    不是 lib 函数；store/mind/nightly/dual 用 getter，宿主重开库后不读旧实例。
//
// 成年鱼（n26/n44）：判据只看事件流里 `meta.kind:'demo'`，不看配置；领养成功后重置分流缓存，
// 工具面在注册时读一次事件流决定是否多挂 pisces_self / pisces_teach / pisces_guide / pisces_check；
// 提示词桥的 buildSections 也要先判 demo 再传进去，否则普通鱼也会挂 pisces:fixed。
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolveRoot, paths, ensureDirs } from './lib/paths.js'
import { acquire, release } from './lib/lock.js'
import { createStore } from './lib/store.js'
import { createMind } from './lib/split.js'
import { deriveSelf } from './lib/derive.js'
import { computeAffinity, maskAffinity } from './lib/affinity.js'
import { computeReveal } from './lib/reveal.js'
import { attachToAgents } from './lib/attach.js'
import { attachDual } from './lib/dual.js'
import { buildDevState, buildTrace, registerTools } from './lib/tools.js'
import { devWriteSelf, patchCard, readCard, tamperCheck } from './lib/card.js'
import {
  BIASES,
  MAX_FRAGMENTS,
  MAX_FRAGMENT,
  MAX_TOTAL,
  biasOf,
  initialDominance,
  seedOf,
  writeSeed as writeSeedToStore,
} from './lib/seed.js'
import { search } from './lib/search.js'
import { listQuestions, setQuestionStatus } from './lib/questions.js'
import { verifyDreams } from './lib/verify.js'
import { learn as learnFromStore } from './lib/learn.js'
import { importBrain, worldSummary, worldThreads } from './lib/world.js'
import { createNightly, inNightlyWindow, NIGHTLY_WINDOW } from './lib/nightly.js'
import { IDLE_QUIET_MS, ranNightlyToday, shouldRunIdle } from './lib/idle-nightly.js'
import { importFishEvents, importFishRoot } from './lib/import.js'
import { exportCardV2, exportSoulBundle, importSoulBundle } from './lib/export.js'
import { PREFIX as CONSOLE_PREFIX, ADULT_LABEL, ADULT_NAME, registerConsole } from './lib/console.js'
import { createLocalModel, probeLocalModel } from './lib/ollama.js'
import { buildSections, devOverlayOf, FIXED_PERSONA, fixedPersonaFor } from './lib/persona.js'
import { scan } from './lib/guard.js'
import { adoptAdult, demoLabel, demoName, isDemo } from './lib/adopt.js'
import { nicknameOf, setNickname as writeNickname } from './lib/nickname.js'
import { clearFixedOverride, readFixedOverride, writeFixedOverride } from './lib/personafile.js'
import { ensureHomeWithRetry, HOME_FILE } from './lib/home.js'
import { createRoomRuntime } from './lib/room-runtime.js'
import { readSetup, writeSetup } from './lib/setup-file.js'
import { planSetup } from './lib/setup-choice.js'
import { migrateSetup } from './lib/setup-migrate.js'
import { openPiscesBank, piscesBankRoot } from './lib/pisces-bank.js'
import { appendRoomLog, absorbRoomLog } from './lib/room-log.js'
import { createInvite, consumeInvite, pendingInvites, openTicket, readTicket, readTicketInfo, markBack, isBackText } from './lib/room-invite.js'
import { splitRoom } from './lib/room.js'
import { attachPiscesSolo, ensurePiscesHome, isPiscesHomeSession } from './lib/pisces-home.js'
import { ensureRoomHome, readRoomHome, roomHomePaths } from './lib/room-home.js'
import { relationLines } from './lib/relation.js'
import { getCast, setCast } from './lib/cast.js'
import { readCastFile } from './lib/cast-file.js'
import { welcomeText } from './lib/welcome.js'
import { SCHEMA as SETTINGS_SCHEMA, mergeConfig, publicSettings, readSettings, writeSettings } from './lib/settings.js'
import { discoverPacks, pickMeme } from './lib/meme.js'
import { clearBili, hot, loginBili, readBili } from './lib/bili.js'
import { createQrLogin } from './lib/biliqr.js'
import { clearBaidu, loginBaidu, readBaidu } from './lib/baidu.js'
import { speak as speakOnBili } from './lib/speak.js'
import { guideFor as teachFor } from './lib/teach.js'
import * as guide from './lib/guide.js'
import { dayOf } from './lib/util.js'
import { VOICE_DIR, detectAdapter, loadVoiceConfig, shouldReplyWithVoice, synthesizeToFile } from './lib/voice.js'

export const name = 'dsh-pisces-core'
export const inject = ['tools']

/**
 * 发布标记：读 package.json 的 `dsh.pisces.release === true`。
 * 缺文件、坏 JSON、没有这个字段都当开发版（false）——发布包由 tools/build-release.mjs 改写。
 * @param {string} [file] package.json 路径；测试可以传临时文件。
 */
export function readRelease(file = join(import.meta.dirname, 'package.json')) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const pkg = JSON.parse(raw)
    return pkg?.dsh?.pisces?.release === true
  } catch {
    return false
  }
}

const LOG_PREFIX = '[dsh-pisces-core]'
const NIGHTLY_TICK_MS = 10 * 60 * 1000
// 体检的「很久」：超过七天没整理、或一个问题悬了七天，都算该看一眼。
const CHECK_STALE_MS = 7 * 86_400_000
const RECENT_TYPES = ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'answer', 'dream_sim']

// 成年鱼样本随包走；路径从本文件算，不依赖宿主的 cwd。
const ADULT_FILE = join(import.meta.dirname, 'assets', 'adult-fish.soul.json')

let applyCount = 0

const errText = (err) => String(err?.message ?? err ?? '未知错误')

function upperOf(v) {
  return String(v ?? '').toUpperCase()
}

/** 从参数里取正文：服务方法同时接受字符串和 { text } 两种形状。 */
function textOf(input) {
  if (typeof input === 'string') return input
  return typeof input?.text === 'string' ? input.text : ''
}

function optionsOf(input) {
  return input && typeof input === 'object' ? input : {}
}

/**
 * 路径归一：反斜杠、尾斜杠、Windows 大小写都抹平（照 dsh-fish 的 `flatPath`）。
 * 只用来比「这条会话的 cwd 是不是在她屋里」，不拿它去开文件。
 */
function flatPath(p) {
  const s = String(p ?? '').split(String.fromCharCode(92)).join('/')
  return (s.endsWith('/') ? s.slice(0, -1) : s).toLowerCase()
}

/** 会话 cwd：字段回退顺序照 dsh-fish 的 `restrict.cwdOf`（真机核实过的形状）。 */
function cwdOf(agent) {
  return (
    agent?.session?.header?.cwd ??
    agent?.header?.cwd ??
    agent?.session?.cwd ??
    ''
  )
}

/** 会话 id：`agent/created` 的负载里两处都见过，取到哪个算哪个。 */
function sidOf(agent) {
  return String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
}

/**
 * 插件入口。任何一步失败都只写日志，不让整个插件挂掉。
 * @returns {() => void} dispose；可重复调用。
 */
export function apply(ctx, config = {}) {
  const n = ++applyCount
  // 宿主 config 是逃生口，优先于 settings；没有 settings.json 时 settings 就是 DEFAULTS。
  const hostConfig = config && typeof config === 'object' ? config : {}
  let cfg = hostConfig
  const log = (...args) => {
    try {
      console.log(LOG_PREFIX, ...args)
    } catch {
      /* 日志失败不影响插件 */
    }
  }
  const safeCtx = ctx && typeof ctx === 'object' ? ctx : {}

  log(`apply#${n} 开始`)

  let root
  let p
  try {
    root = resolveRoot()
    p = ensureDirs(root)
    // 设置中心：只在这里读一次；面板保存后要重启才生效（与 SCHEMA.restart 对齐）。
    cfg = mergeConfig(hostConfig, readSettings(root))
  } catch (e) {
    log(`启动失败：目录准备不了（${errText(e)}）`)
    return () => {}
  }

  // 表情包（n186）：内置包随插件走，用户包放 <root>/memes/<包>/。只读目录，出图走观测台路由。
  const memeBuiltinDir = join(import.meta.dirname, 'assets', 'memes', 'builtin')
  let memeCache = null
  const memePacks = () => {
    if (memeCache !== null) return memeCache
    try {
      memeCache = discoverPacks({ builtinDir: memeBuiltinDir, userDir: join(root, 'memes') })
    } catch (e) {
      log(`表情包读不了：${errText(e)}`)
      memeCache = []
    }
    return memeCache
  }
  const memeRecent = []
  const selectMeme = async ({ mood } = {}) => {
    if (cfg.meme?.enabled === false) return null
    let hit = null
    try {
      hit = pickMeme(memePacks(), { mood, recent: memeRecent.slice(-5) })
    } catch (e) {
      log(`挑表情失败：${errText(e)}`)
      return null
    }
    if (!hit) return null
    memeRecent.push(hit.id)
    if (memeRecent.length > 20) memeRecent.shift()
    // 只记计数用的 meta；记不上不影响发图。
    try {
      const s = await live()
      if (s) {
        await s.append({
          type: 'meta',
          text: `meme:${hit.pack}/${hit.id}`,
          meta: { kind: 'meme', pack: hit.pack, id: hit.id },
          source: 'tool',
        })
      }
    } catch {
      /* 记不上不影响发图 */
    }
    return hit
  }

  // 单实例锁：拿不到也只读继续，不因为另一个实例在写就让插件不加载。
  let lockToken = null
  try {
    const got = acquire(p.lockFile)
    if (got?.ok) {
      lockToken = got.token
    } else {
      const who = got?.holder?.pid != null ? `pid ${got.holder.pid}` : '另一个实例'
      log(`另一个实例在写（${who}），这个实例只读`)
    }
  } catch (e) {
    log(`拿锁失败：${errText(e)}（继续，只读）`)
  }

  // 发布标记：dist/package.json 的 dsh.pisces.release === true。开发版默认 false。
  // 测试可以用 hostConfig.release=true 模拟发布包，不用改真实 package.json。
  const isRelease = readRelease() || hostConfig.release === true

  // 关系 cast（n192）：本机 cast.json 只在非发布版读；发布版强制 RELEASE_CAST。
  if (!isRelease) {
    const cast = readCastFile(root)
    if (cast) {
      setCast(cast)
      log(`关系 cast：${cast.adult.name}(${cast.adult.label}) / ${cast.ordinary.name}(${cast.ordinary.label})`)
    }
  }

  // 开发者钥匙：只在开发版加载。发布包里 lib/devkey.js 已被删掉，所以必须动态 import + try，
  // 不能让静态 import 把整个插件拖挂（n65/n74）。
  let devkeyMod = null
  let devkeyReady = null
  if (!isRelease) {
    devkeyReady = import('./lib/devkey.js')
      .then((m) => {
        devkeyMod = m
        try {
          const dk = m.ensureDevkey(root)
          if (dk?.created) log('开发者钥匙已生成（只显示一次，丢了就重置）')
        } catch (e) {
          log(`开发者钥匙没生成：${errText(e)}`)
        }
        return m
      })
      .catch((e) => {
        log(`开发者钥匙模块没加载：${errText(e)}`)
        return null
      })
  } else {
    log('发布版：开发者钥匙已移除')
  }

  /** 等钥匙模块加载完（开发版）；发布版 / 加载失败返回 null。 */
  async function waitDevkey() {
    if (devkeyReady) {
      try {
        await devkeyReady
      } catch {
        /* 加载失败的 log 在 catch 里已经打过 */
      }
    }
    return devkeyMod
  }

  // 语音回复：条件触发、默认休眠。没接适配器就只记一行，不打扰任何人。
  // 开关藏在 settings 的 voice.enabled（不进 SCHEMA）与 voice.json 的 enabled 里；
  // 现在宿主没有 TTS 服务、也没配命令，所以这里必然走「未接适配器（休眠）」。
  let voiceAdapter = null
  let voiceEnabled = cfg.voice !== false && cfg.voice?.enabled !== false
  let voiceFormat = 'mp3'
  try {
    const vc = loadVoiceConfig(root)
    if (vc?.enabled === false) voiceEnabled = false
    if (vc?.format) voiceFormat = vc.format
    const detected = detectAdapter({ ctx: safeCtx, root })
    voiceAdapter = detected?.ok === true ? detected : null
  } catch (e) {
    // 不再静默：真机上 ctx 探测抛错会被这里吞掉，看起来就像「没有适配器」。
    voiceAdapter = null
    log(`语音回复：探测出错（${errText(e)}）`)
  }
  if (voiceAdapter?.ok) log(`语音回复：已接 ${voiceAdapter.kind}`)
  else log('语音回复：未接适配器（休眠）')

  // B 站扫码登录：key 与 cookie 只活在内存里，停用时清掉（不落盘、不进日志）。
  const qrLogin = createQrLogin({ log })

  let closed = false
  let disposed = false
  let store = null
  let piscesBank = null
  let piscesHome = null
  let roomHome = null
  let piscesSoloOff = null
  let opening = null
  let mindInst = null
  // 第二库（banks/pisces）自己的分流实例：只在选项 3 + together 时建。
  let piscesMindInst = null
  // 夜间按库实例：'main'（鲸歌主库）/ 'pisces'（她单独那边）。主库那一个的参数与以前完全一致。
  const nightlyInsts = new Map()
  let nightlyModel = null
  let nightlyProbed = false
  let nightlyTimer = null
  // 空闲整理（lib/idle-nightly.js）：10 分钟看一次，单飞，绝不和主库夜间窗口重叠。
  let idleTimer = null
  let idleRunning = false
  let attachOff = null
  let attachRoomOff = null
  let roomInfoGetter = null
  let dualOff = null
  let consoleMount = null
  let consoleInjectOff = null
  let consolePollTimer = null
  let consolePollCount = 0

  function releaseLock() {
    if (!lockToken) return
    try {
      release(p.lockFile, lockToken)
    } catch {
      /* 锁过期/被接管都算释放过了 */
    }
    lockToken = null
  }

  /** 按需重开库：停用之后也允许（n28）。不抢锁，只读/临时写。 */
  async function ensureLive() {
    if (store && (typeof store.isOpen !== 'function' || store.isOpen())) return store
    if (opening) return opening
    opening = (async () => {
      try {
        mindInst = null
        piscesMindInst = null
        nightlyInsts.clear()
        const s = await createStore({ root, forceJsonl: Boolean(cfg.jsonl), log })
        store = s
        try {
          mindInst = createMind({
            store: s,
            log,
            config: cfg.mind || {},
            startDominance: initialDominance(s.readAll()),
          })
        } catch (e) {
          log(`分流初始化失败：${errText(e)}`)
        }
        log(`按需开库：${root}（${s.backend || 'sqlite'}，${s.count()} 条事件）`)
        return s
      } catch (e) {
        log(`按需开库失败：${errText(e)}`)
        return null
      } finally {
        opening = null
      }
    })()
    return opening
  }

  // ready 可能是 null（启动期被停用），也可能是一个已经被 dispose 关掉的库；
  // 两种都走 ensureLive()，服务方法才不会拿着关掉的 store 去读写。
  const live = async () => {
    const s = await ready
    if (s && (typeof s.isOpen !== 'function' || s.isOpen())) return s
    return ensureLive()
  }

  /** 选项 3 一同成长=是：按需打开第二个派希丝库。只在她那条线有写入时用。 */
  async function ensurePiscesBank() {
    if (piscesBank) return piscesBank
    const setup = readSetup(root)
    if (!setup || setup.together !== true) return null
    piscesBank = await openPiscesBank(root, { log })
    log(`派希丝库已开：${piscesBank.root || 'banks/pisces'}`)
    return piscesBank
  }

  /**
   * 这条会话属于哪个库：她单独家那条 → 'pisces'；其它 → 'main'。
   * 判据复用第二库 attach 的那一份（lib/pisces-home.js 的 isPiscesHomeSession：
   * home.json 的 sessionId / cwd 前缀），不在这里另写一套。
   */
  function bankOf(sessionId = '', cwd = '') {
    try {
      if (isPiscesHomeSession(root, {
        sessionId: String(sessionId ?? ''),
        cwd: String(cwd ?? ''),
      })) return 'pisces'
    } catch {
      /* 判据失败按主库：卡写错库比不写更糟 */
    }
    return 'main'
  }

  /** 工具执行带回来的 agent → {sessionId, cwd}；拿不到就给空串（bankOf 会走主库）。 */
  function sessionOfAgent(agent) {
    try {
      return {
        sessionId: sidOf(agent)
          || String(agent?.sessionId ?? '')
          || String(agent?.ctx?.session?.id ?? '')
          || String(agent?.ctx?.session?.header?.id ?? ''),
        cwd: cwdOf(agent)
          || String(agent?.cwd ?? '')
          || String(agent?.ctx?.cwd ?? '')
          || String(agent?.ctx?.session?.header?.cwd ?? ''),
      }
    } catch {
      return { sessionId: '', cwd: '' }
    }
  }

  /** 第二库自己的分流实例（她的库、她的状态）；没有库回 null。 */
  function getPiscesMind(bank = null) {
    const b = bank || piscesBank
    if (!b || (typeof b.isOpen === 'function' && !b.isOpen())) return null
    if (!piscesMindInst) {
      try {
        piscesMindInst = createMind({
          store: b,
          log,
          config: cfg.mind || {},
          startDominance: initialDominance(b.readAll()),
        })
      } catch (e) {
        log(`派希丝分流初始化失败：${errText(e)}`)
        return null
      }
    }
    return piscesMindInst
  }

  /** 夜间从客厅共享日志吸收：鲸歌走主库、派希丝走第二库；各库自己的游标防重复。
   *  role 给了就只吸那一个库（邀请码手动补吸用）。 */
  async function absorbRoomLogs({ now = Date.now(), role = null } = {}) {
    const main = await live()
    const stores = []
    if (main && (!role || role === 'ordinary')) stores.push({ store: main, role: 'ordinary' })
    if (!role || role === 'adult') {
      const pisces = await ensurePiscesBank()
      if (pisces) stores.push({ store: pisces, role: 'adult' })
    }
    return absorbRoomLog({ root, stores, now })
  }

  /**
   * 回家的收码人：各自家里说一句「我回来了」，就把客厅那几轮收进**她那一边**的库，
   * 不用码。两只回家中间隔着时间也没关系：各记各的一格，**两只都回来才关门**。
   */
  function backAbsorber(role) {
    return (text) => {
      if (!isBackText(text)) return null
      void absorbRoomLogs({ role })
        .then((r) => log(`客厅记录已收进${role === 'adult' ? '派希丝' : '鲸歌'}的库：${r?.recorded ?? 0} 条（回家）`))
        .catch((e) => log(`客厅记录没收进去（回家）：${errText(e)}`))
      let back = null
      try { back = markBack(root, role) } catch { back = null }
      if (back?.closed) log('客厅：两只都回来了，门关上')
      return { ok: true }
    }
  }

  /** 派希丝自己的家：第二个工作区 + 会话；只在 together=true 时建。 */
  async function ensurePiscesHomeOnce() {
    if (piscesHome?.ok) return piscesHome
    const setup = readSetup(root)
    if (!setup || setup.together !== true) return null
    const homeCfg = cfg.home && typeof cfg.home === 'object' ? cfg.home : {}
    try {
      piscesHome = await ensurePiscesHome({
        ctx: safeCtx,
        root,
        log,
        retryMs: homeCfg.retryMs,
        max: homeCfg.max,
        wait: homeCfg.wait,
      })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
    if (piscesHome?.ok && !piscesSoloOff) {
      try {
        await ensurePiscesBank()
        piscesSoloOff = attachPiscesSolo({
          ctx: safeCtx,
          root,
          home: piscesHome,
          getBank: () => ensurePiscesBank(),
          roomBack: backAbsorber('adult'),
          config: cfg,
          log,
        })
        log(`派希丝的单独家已挂上：${piscesHome.workspaceTitle} / ${piscesHome.sessionTitle}`)
      } catch (e) {
        log(`派希丝的单独家挂载失败：${errText(e)}`)
      }
    }
    return piscesHome
  }

  /** 客厅自己的家：第三个工作区 + 会话；只在 setup.room === true 时建。 */
  async function ensureRoomHomeOnce() {
    if (roomHome?.ok) return roomHome
    const setup = readSetup(root)
    if (!setup || setup.room !== true) return null
    const homeCfg = cfg.home && typeof cfg.home === 'object' ? cfg.home : {}
    try {
      roomHome = await ensureRoomHome({
        ctx: safeCtx,
        root,
        log,
        retryMs: homeCfg.retryMs,
        max: homeCfg.max,
        wait: homeCfg.wait,
      })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
    if (roomHome?.ok) log(`客厅建好了：${roomHome.workspaceTitle} / ${roomHome.sessionTitle}`)
    else log(`客厅没建好：${roomHome?.reason ?? '原因不明'}`)
    return roomHome
  }

  // 启动：createStore 之后先看 closed，停用过的实例把刚建好的库回收掉（n5）。
  const ready = (async () => {
    let s
    try {
      s = await createStore({ root, forceJsonl: Boolean(cfg.jsonl), log })
    } catch (e) {
      log(`启动失败：${errText(e)}`)
      releaseLock()
      return null
    }
    if (closed) {
      try {
        s.close()
      } catch {
        /* 已经关了 */
      }
      releaseLock()
      log(`启动过程中就被停用了，已回收（apply#${n}）`)
      return null
    }
    store = s
    try {
      mindInst = createMind({
        store: s,
        log,
        config: cfg.mind || {},
        startDominance: initialDominance(s.readAll()),
      })
    } catch (e) {
      log(`分流初始化失败：${errText(e)}`)
    }
    try {
      log(`已就绪：${root}（${s.backend || 'sqlite'}，${s.count()} 条事件）`)
    } catch {
      log(`已就绪：${root}`)
    }
    startNightlyTimer()
    // 第二库的空闲整理：默认关（设置 pisces.idleNightly），单库模式下定时器也只空转。
    startIdlePiscesNightly()
    return s
  })()

  // ---- 服务方法：每个都先 live()，拿不到库就回 not-ready --------------------

  async function getMind() {
    const s = await live()
    if (!s) return null
    if (!mindInst) {
      try {
        mindInst = createMind({
          store: s,
          log,
          config: cfg.mind || {},
          startDominance: initialDominance(s.readAll()),
        })
      } catch (e) {
        log(`分流初始化失败：${errText(e)}`)
        return null
      }
    }
    return mindInst
  }

  const notReady = () => ({ ok: false, reason: 'not-ready' })

  async function recall(input = {}, kArg, budgetArg) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(input)
    const query = typeof input === 'string' ? input : String(o.query ?? '')
    const k = Number(o.k ?? kArg)
    const budget = Number(o.budget ?? budgetArg)
    return {
      ok: true,
      ...search(s, {
        query,
        k: Number.isFinite(k) && k > 0 ? k : 8,
        budget: Number.isFinite(budget) && budget > 0 ? budget : 800,
      }),
    }
  }

  async function remember(input, typeArg, refsArg) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(input)
    const text = textOf(input)
    const type = typeof input === 'string' ? typeArg : o.type
    const refs = typeof input === 'string' ? refsArg : o.refs
    try {
      const event = await s.append({
        type: type || 'utterance',
        text,
        refs: Array.isArray(refs) ? refs : [],
        source: 'tool',
      })
      return { ok: true, event, id: event?.id ?? null }
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  async function ask(input, refsArg) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(input)
    const text = textOf(input)
    const refs = typeof input === 'string' ? refsArg : o.refs
    try {
      const event = await s.append({
        type: 'ask',
        text,
        refs: Array.isArray(refs) ? refs : [],
        source: 'tool',
      })
      return { ok: true, event, id: event?.id ?? null }
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  async function cardPatch(args = {}) {
    // 卡跟着会话所属的库走：她单独家那条会话改的是 banks/pisces 的卡，别写进鲸歌的。
    // 拿不到会话（服务直调/旧工具）就还是主库，和以前完全一样。
    const who = sessionOfAgent(args?.agent)
    const bank = bankOf(who.sessionId, who.cwd)
    let s = null
    let cardRoot = root
    if (bank === 'pisces') {
      try {
        s = await ensurePiscesBank()
      } catch {
        s = null
      }
      if (s) cardRoot = String(s.root || piscesBankRoot(root))
    }
    if (!s) s = await live()
    if (!s) return { ok: false, decision: 'rejected', rev: 0, reasons: ['not-ready'] }
    try {
      return await patchCard(args, {
        root: cardRoot,
        store: s,
        now: Date.now(),
        log,
        // 第八道闸只认 reviewModel；没有就显式关掉（card.js 自己会 log 一次）。
        cfg: {
          reviewModel: cfg.card?.reviewModel,
          review: cfg.card?.review !== false,
        },
        reviewer: makeReviewer(),
      })
    } catch (e) {
      return { ok: false, decision: 'rejected', rev: 0, reasons: [errText(e)] }
    }
  }

  /** 日记：同一天接在后面（diaryPut 是 INSERT OR REPLACE，不能直接写两次）。 */
  async function diary(input) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(input)
    const text = textOf(input)
    if (!String(text ?? '').trim()) return { ok: false, reason: '没写进日记' }
    const now = Date.now()
    const day = o.day != null && String(o.day).trim() ? String(o.day) : dayOf(now)
    let prior = ''
    try {
      const rows = typeof s.diaryAll === 'function' ? s.diaryAll() : []
      const row = Array.isArray(rows) ? rows.find((x) => String(x?.day) === day) : null
      prior = row ? String(row.text ?? '') : ''
    } catch {
      prior = ''
    }
    const merged = prior.trim() ? `${prior.replace(/\s+$/, '')}\n\n${text}` : text
    try {
      s.diaryPut([{ day, text: merged, at: now }])
      return { ok: true, day, text: merged, chars: merged.length }
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  /** 起点状态：形状照 contract/console 的期望（limits 用 fragment，不是 perFragment）。 */
  async function seed() {
    const s = await live()
    if (!s) return notReady()
    const events = s.readAll() || []
    const ev = seedOf(events)
    const fragments = ev
      ? Array.isArray(ev.meta?.fragments)
        ? ev.meta.fragments.map(String)
        : String(ev.text ?? '')
            .split(/\n{2,}/)
            .filter(Boolean)
      : []
    const current = ev
      ? {
          text: String(ev.text ?? ''),
          fragments,
          chars: Number(ev.meta?.chars) || fragments.join('').length,
          bias: ev.meta?.bias ? String(ev.meta.bias) : null,
          biasName: biasOf(ev.meta?.bias)?.name ?? null,
          at: Number(ev.ts) || null,
          day: ev.day ?? null,
          source: ev.source ?? null,
        }
      : null
    return {
      ok: true,
      hasSeed: !!ev,
      canWrite: !ev,
      limits: { fragments: MAX_FRAGMENTS, fragment: MAX_FRAGMENT, total: MAX_TOTAL },
      biases: BIASES.map((b) => ({ id: b.id, name: b.name, hint: b.hint })),
      current,
      demo: ev ? null : { name: ADULT_NAME, label: ADULT_LABEL },
      adult: { name: ADULT_NAME, label: ADULT_LABEL, available: !ev },
    }
  }

  async function writeSeed(texts, bias) {
    const s = await live()
    if (!s) return notReady()
    const r = await writeSeedToStore({ store: s, texts, bias })
    // 起点决定初始主导：写完把缓存的分流状态丢掉，下一次 describe 才是新的开始。
    if (r?.ok) {
      mindInst = null
      await getMind()
    }
    return r
  }

  /**
   * 领养成年鱼：只在还没有起点时可用（n44）。
   * 失败原样退回 adoptAdult 的 {ok:false, reason}；成功要重算分流（起点变了）。
   */
  async function adopt() {
    const s = await live()
    if (!s) return notReady()
    let r
    try {
      r = await adoptAdult({ root, store: s, file: ADULT_FILE, now: Date.now() })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
    if (!r?.ok) return r ?? { ok: false, reason: '领养失败' }
    // 样本自带起点和偏向，缓存里的旧主导（多半是空库时的 0.5）必须丢掉。
    mindInst = null
    await getMind()
    // 领养成功 → 顺手把家建出来（幂等；宿主不支持就只 log 一行，不影响领养结果）。
    // 不阻塞：服务晚就绪时要等重试窗口，领养结果不该跟着一起拖。
    void ensureHomeOnce().catch((e) => {
      log(`家没建好：${errText(e)}`)
    })
    return { ok: true, name: r.name, label: r.label, events: r.events, demo: true }
  }

  /** 事件流里的成年鱼标记 → {name,label}|null。只认 meta.kind='demo'，不看配置。 */
  function demoOf(events) {
    return isDemo(events) ? { name: demoName(events), label: demoLabel(events) } : null
  }

  /**
   * 开局三选项：只选一次。1 会顺手领养成年鱼；2/3 先写 setup，起点由页面继续写。
   * 不改已存在的 setup；不自动回填/伪造普通鱼事件。
   */
  async function setupStart({ mode = 'pisces', together = false } = {}) {
    const existing = readSetup(root)
    if (existing) return { ok: false, reason: '开局已经选过了，不能改', setup: existing }
    const s = await live()
    if (!s) return notReady()
    let events = []
    try {
      events = s.readAll() || []
    } catch {
      events = []
    }
    const plan = planSetup({
      mode,
      together,
      hasSetup: false,
      hasSeed: !!seedOf(events),
      hasDemo: isDemo(events),
    })
    if (!plan.ok) return plan
    if (plan.actions.includes('adopt')) {
      const r = await adopt()
      if (!r?.ok) return r
    }
    try {
      writeSetup(root, plan.setup)
    } catch (e) {
      return { ok: false, reason: `setup 写不进去：${errText(e)}` }
    }
    // 单独姐姐/妹妹：开场存一条 welcome 事件，供面板/工具回看；客厅 3 连不存。
    if (mode === 'pisces' || mode === 'sister') {
      try {
        const text = welcomeText(mode)
        await s.append({
          type: 'welcome',
          source: 'agent',
          text,
          meta: { kind: 'welcome', scope: 'solo', setupMode: mode },
        })
      } catch (e) {
        log(`welcome 事件没写进去：${errText(e)}`)
      }
    }
    // 一同成长=是：建第二个派希丝库；失败只 warning，不把 setup 回滚。
    let bankError = ''
    if (plan.needsPiscesBank) {
      try {
        await ensurePiscesBank()
        const h = await ensurePiscesHomeOnce()
        if (h && h.ok === false) bankError = String(h.reason || '第二库/第二条会话没建好')
      } catch (e) {
        bankError = errText(e)
        log(`派希丝库/家没开成：${bankError}`)
      }
    }
    return {
      ok: true,
      setup: plan.setup,
      actions: plan.actions,
      needsPiscesBank: plan.needsPiscesBank,
      ...(plan.needsPiscesBank
        ? { warning: bankError ? `一同成长：第二个库没开成（${bankError}）` : '一同成长：两个库已建好' }
        : {}),
    }
  }

  async function setupInfo() {
    const current = readSetup(root)
    if (current) return { ok: true, setup: current, migrated: false }
    const s = await live()
    if (!s) return { ok: true, setup: null, migrated: false }
    try {
      const r = migrateSetup({
        root,
        events: s.readAll() || [],
        read: readSetup,
        write: writeSetup,
      })
      if (r.migrated) log('开局：按现有鱼补了 setup.json')
      return { ok: true, setup: r.setup, migrated: r.migrated }
    } catch (e) {
      log(`开局迁移失败：${errText(e)}`)
      return { ok: true, setup: null, migrated: false }
    }
  }

  /** 单独派希丝/妹妹的开场：读最后一条 welcome 事件；没有就 null。 */
  async function welcomeInfo() {
    const s = await live()
    if (!s) return notReady()
    let events = []
    try {
      events = s.readAll() || []
    } catch {
      events = []
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'welcome' && e?.meta?.kind === 'welcome') {
        return { ok: true, text: String(e.text || ''), at: Number(e.ts) || null }
      }
    }
    return { ok: true, text: null, at: null }
  }

  async function demoInfo() {
    const s = await live()
    if (!s) return notReady()
    const d = demoOf(s.readAll() || [])
    return { ok: true, demo: d != null, name: d?.name ?? null, label: d?.label ?? null }
  }

  /** 当前昵称：事件流里最后一条 meta.kind='nickname'；没有就 null。 */
  async function nickname() {
    const s = await live()
    if (!s) return notReady()
    return { ok: true, nickname: nicknameOf(s.readAll() || []) }
  }

  /**
   * 改昵称：只追加一条事件，不改固定名字；只有成年鱼能改（判据同工具面/面板，只看事件流）。
   * 返回 lib/nickname.js 的 {ok:true,name,event} 或 {ok:false,reason}。
   */
  async function setNickname(name) {
    const s = await live()
    if (!s) return notReady()
    let events = []
    try {
      events = s.readAll() || []
    } catch {
      events = []
    }
    if (!isDemo(events)) return { ok: false, reason: '只有成年鱼可以起昵称' }
    return writeNickname({ store: s, name, now: Date.now() })
  }

  /**
   * 开发者钥匙状态：只回有没有，**绝不回 key/哈希**。发布版没有钥匙模块 → ok:false。
   */
  async function devkey() {
    const m = await waitDevkey()
    if (!m) return { ok: false, reason: '开发者钥匙不可用' }
    return { ok: true, hasKey: m.hasDevkey(root) }
  }

  /** 重置开发者钥匙：明文只在这一刻返回一次；旧 key 立刻失效。 */
  async function rotateDevkey() {
    const m = await waitDevkey()
    if (!m) return { ok: false, reason: '开发者钥匙不可用' }
    try {
      return { ok: true, ...m.rotateDevkey(root) }
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  /** 删掉开发者钥匙（面板/接口的 DELETE 入口）。 */
  async function deleteDevkey() {
    const m = await waitDevkey()
    if (!m) return { ok: false, reason: '开发者钥匙不可用' }
    const removed = m.deleteDevkey(root)
    return { ok: true, removed, hasKey: m.hasDevkey(root) }
  }

  /**
   * 固定段覆盖（`<root>/persona-fixed.md`）：读现状、写、清。
   * 文件层由 lib/personafile.js 负责（备份 + 原子写 + 4000 字上限）；这里不加闸——
   * 只有持钥匙的人能走到这里，且只影响成年鱼（普通鱼没有 pisces:fixed）。
   */
  async function fixed() {
    const override = readFixedOverride(root)
    return { ok: true, overridden: override != null, text: override ?? FIXED_PERSONA }
  }

  function setFixed(text) {
    return writeFixedOverride(root, text)
  }

  function clearFixed() {
    return clearFixedOverride(root)
  }

  /**
   * 开发者直接写卡（`pisces_dev action:'card'` 的依赖）：钥匙已经由工具层验过，
   * 这里只负责取库、写卡、刷摘要、落 `card_patch(dev:true)`；返回 {ok,rev} 或 {ok:false,reason}。
   */
  async function devCard({ text } = {}) {
    const s = await live()
    if (!s) return { ok: false, reason: '库没读到' }
    try {
      return await devWriteSelf(root, { text, store: s, now: Date.now(), log })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  /**
   * 开发者看人设卡（`pisces_dev action:'card-read'` 的依赖）：只读 `card/self.md`，
   * 不建卡、不写卡、不刷摘要、不落事件。返回 {ok:true,text,rev}（text 是正文，不含「# 我」抬头）
   * 或 {ok:false,reason}；卡文件不存在/是空的时候 reason 是「卡还没写」。
   */
  async function readCardSelf(agent = null) {
    try {
      // 读卡也按库：她单独家那条会话看的是 banks/pisces 的卡。
      const who = sessionOfAgent(agent)
      const bank = bankOf(who.sessionId, who.cwd)
      const cardRoot = bank === 'pisces' ? piscesBankRoot(root) : root
      const card = readCard(cardRoot)
      const raw = String(card.self ?? '')
      if (!raw.trim()) return { ok: false, reason: '卡还没写' }
      return { ok: true, text: card.selfBody, rev: Number(card.state?.rev) || 0 }
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  /**
   * 家：在宿主侧栏建一个工作区 + 一条会话，名字跟着成年鱼的名字走（lib/home.js 负责幂等）。
   * 领养成功和启动（已有 demo/起点）两处都调它，测试里 service.home() 也能直接调。
   * 失败只回 {ok:false, reason}、只 log 一行，不阻塞启动（宿主没有 workspaceRegistry 也照跑）。
   */
  async function ensureHomeOnce() {
    if (cfg.home?.enabled === false || cfg.home?.auto === false) return { ok: false, reason: '家没开（config.home.enabled=false 或 home.auto=false）' }
    let fish = null
    try {
      const s = await live()
      const events = s ? s.readAll() || [] : []
      // 只有成年鱼才有名字；普通鱼叫「肥鱼」（homeTitles 的缺省）。
      if (isDemo(events)) fish = demoName(events) || null
    } catch {
      fish = null
    }
    const homeCfg = cfg.home && typeof cfg.home === 'object' ? cfg.home : {}
    let r
    try {
      // 宿主的 workspace 服务可能比插件晚注册：拿不到就等在重试窗口里（n52/n55）。
      r = await ensureHomeWithRetry({
        ctx: safeCtx,
        root,
        name: fish,
        log,
        retryMs: homeCfg.retryMs,
        max: homeCfg.max,
        // 测试注入用：生产配置别填。
        wait: homeCfg.wait,
      })
    } catch (e) {
      r = { ok: false, reason: errText(e) }
    }
    if (r?.ok) log(`家建好了：${r.workspaceTitle} / ${r.sessionTitle}`)
    else log(`家没建好：${r?.reason ?? '原因不明'}`)
    return r
  }

  /** 同一套口径算一份状态；换哪个库由调用方给（主库 / 派希丝第二库）。 */
  async function stateOf(s, md = {}) {
    if (!s) return notReady()
    const events = s.readAll() || []
    const d = deriveSelf(events)
    let mode = null
    try {
      const raw = s.modeGet?.('state')
      mode = raw ? JSON.parse(raw) : null
    } catch {
      mode = null
    }
    const open = listQuestions(s, { status: 'open', limit: 3 })
    const openAll = listQuestions(s, { status: 'open', limit: 50 })
    const dreams = events.filter((e) => e.type === 'dream_sim' && e.meta?.status !== 'rejected')
    const dreamsRejected = events.filter((e) => e.type === 'dream_sim' && e.meta?.status === 'rejected')
    const verified = events.filter((e) => e.meta?.kind === 'dream_observed')
    const recent = events
      .filter((e) => RECENT_TYPES.includes(e.type))
      .slice(-5)
      .reverse()
      .map((e) => ({ id: e.id, day: e.day, type: e.type, text: e.text, ts: e.ts }))
    const attribution = { d: 0, i: 0, null: 0, total: 0 }
    try {
      for (const row of s.attribAll?.() || []) {
        const key = row?.label === 'd' || row?.label === 'i' ? row.label : 'null'
        attribution[key] += 1
        attribution.total += 1
      }
    } catch {
      /* 归因表读不到不算错 */
    }
    // 好感：从事件流推导（lib/affinity.js），不落库、不加计数器表；派希丝的数字过 reveal 遮罩。
    const demo = demoOf(events)
    let allQuestions = []
    try {
      allQuestions = s.questionAll?.() || []
    } catch {
      allQuestions = []
    }
    const reveal = demo ? computeReveal({ events, now: Date.now() }) : null
    const affinity = maskAffinity(
      computeAffinity({ events, questions: allQuestions, now: Date.now() }),
      reveal ? reveal.level : Infinity,
    )
    return {
      ok: true,
      day: d.day,
      events: events.length,
      backend: s.backend || 'sqlite',
      // 面板用：成年鱼时给 {name,label}，普通鱼 null（判据同工具面，只看事件流）。
      demo,
      affinity,
      order: mode?.order ?? md.order ?? 'E=R',
      dominance: mode?.dominance ?? md.dominance ?? 0.5,
      split: mode?.split != null || md.splitAt != null,
      attribution,
      openQuestions: openAll.length,
      questions: open,
      dreams: dreams.length,
      dreamsRejected: dreamsRejected.length,
      verified: verified.length,
      recent,
      // 客厅调试：只给次数/最后一条错误/llm 在不在，不碰对话正文。
      room: typeof roomInfoGetter === 'function' ? roomInfoGetter() : null,
    }
  }

  /** 主库（鲸歌）的状态。 */
  async function state() {
    const s = await live()
    if (!s) return notReady()
    let md = {}
    try { md = (await getMind())?.describe?.() || {} } catch { md = {} }
    return stateOf(s, md)
  }

  /** 派希丝第二库的状态：同一套口径，分流用她自己的 mind 实例（没有就给默认值）。 */
  async function piscesState() {
    let b = null
    try { b = await ensurePiscesBank() } catch { b = null }
    if (!b) return { ok: false, reason: '没有第二库（setup.together 关着？）' }
    let md = {}
    try { md = getPiscesMind(b)?.describe?.() || {} } catch { md = {} }
    return stateOf(b, md)
  }

  /**
   * 开发者看完整状态（`pisces_dev action:'state'` 的依赖）：**绕过**面板/接口的 reveal 遮罩
   * （n57：遮罩只管面板和 `/state` 路由，这一支只回聊天），读全部事件（含成年鱼样本自带的
   * 90 天历史）、分流、派生、好感与悬着的问题，折成一段人话。
   * 只读：不写事件、不动卡、不改遮罩；格式化是 tools.js 的纯函数 `buildDevState`。
   * 没有库 / 读失败回人话（不抛给宿主），其余每一步失败都各自降级。
   */
  async function fullState() {
    let s = null
    try {
      s = await live()
    } catch {
      s = null
    }
    if (!s) return '[看不出：库没读到]'
    let events = []
    try {
      events = s.readAll() || []
    } catch {
      return '[看不出：库没读到]'
    }
    const derived = deriveSelf(events)
    let mind = {}
    try {
      mind = (await getMind())?.describe?.() || {}
    } catch {
      mind = {}
    }
    let questions = []
    try {
      questions = listQuestions(s, { status: 'open', limit: 50 })
    } catch {
      questions = []
    }
    let allQuestions = []
    try {
      allQuestions = s.questionAll?.() || []
    } catch {
      allQuestions = []
    }
    let attrib = []
    try {
      attrib = s.attribAll?.() || []
    } catch {
      attrib = []
    }
    let affinity = null
    try {
      affinity = computeAffinity({ events, questions: allQuestions, now: Date.now() })
    } catch {
      affinity = null
    }
    return buildDevState({ events, derived, mind, affinity, questions, attrib })
  }

  /**
   * 体检：给 pisces_check 用的一行回执。只读（state + 现算好感 + 问题表），不落库、不写事件。
   * 不抛：任何一步失败都回「[看不出] 面板没读出来」。
   */
  async function checkup() {
    try {
      const st = await service.state()
      if (!st || st.ok === false) return '[看不出] 面板没读出来'
      const s = await live()
      if (!s) return '[看不出] 面板没读出来'
      let events = []
      try {
        events = s.readAll() || []
      } catch {
        events = []
      }
      let allQuestions = []
      try {
        allQuestions = s.questionAll?.() || []
      } catch {
        allQuestions = []
      }
      const hasSeed = events.some((e) => e?.type === 'seed')
      // 好感从事件流现算（不走 state.affinity：成年鱼那份是遮过的）。
      const affinity = computeAffinity({ events, questions: allQuestions, now: Date.now() })
      const open = allQuestions.filter((q) => String(q?.status) === 'open')
      let last = null
      try {
        last = getNightly()?.last?.() ?? null
      } catch {
        last = null
      }
      const lastAt = Number(last)
      const hasLast = last != null && Number.isFinite(lastAt)
      const lastText = hasLast ? dayOf(lastAt) : '还没整理过'
      const problems = []
      if (!hasSeed) problems.push('没起点')
      if (hasLast ? Date.now() - lastAt > CHECK_STALE_MS : events.length > 1) problems.push('很久没整理')
      const staleQuestion = open.some((q) => {
        const since = Number(q?.since)
        return Number.isFinite(since) && Date.now() - since > CHECK_STALE_MS
      })
      if (staleQuestion) problems.push('有问题悬着太久')
      const nums = `天数 ${Math.trunc(Number(st.day) || 0)} · 事件 ${Math.trunc(Number(st.events) || 0)} · 问题 ${open.length} · 好感 ${Math.round(Number(affinity.value) || 0)} · 上次整理 ${lastText}`
      return problems.length ? `[有点问题] ${problems.join(' / ')} · ${nums}` : `[她挺好] ${nums}`
    } catch {
      return '[看不出] 面板没读出来'
    }
  }

  async function derive() {
    const s = await live()
    if (!s) return notReady()
    return { ok: true, ...deriveSelf(s.readAll() || []) }
  }

  async function exportCard(opts = {}) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(opts)
    return exportCardV2({
      root,
      store: s,
      now: Number(o.now) || Date.now(),
      outPath: o.outPath ?? null,
    })
  }

  async function exportSoul(opts = {}) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(opts)
    return exportSoulBundle({
      root,
      store: s,
      now: Number(o.now) || Date.now(),
      outPath: o.outPath ?? null,
    })
  }

  async function importFish(target) {
    const s = await live()
    if (!s) return notReady()
    const dir = typeof target === 'string' ? target : target?.dir ?? target?.file ?? ''
    if (!dir) return { ok: false, reason: '要给我 dsh-fish 的目录' }
    try {
      if (/\.jsonl$/i.test(String(dir))) {
        return await importFishEvents({ file: String(dir), store: s, log })
      }
      return await importFishRoot({ dir: String(dir), store: s, log })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  async function importSoul(target) {
    const s = await live()
    if (!s) return notReady()
    const file = typeof target === 'string' ? target : target?.file
    if (!file) return { ok: false, reason: '要给我 bundle 文件' }
    try {
      return await importSoulBundle({ file: String(file), store: s, root, now: Date.now() })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }

  // world：既是一个「看常识层」的函数，也带 import/summary/threads 三个入口。
  async function world(input = {}) {
    const s = await live()
    if (!s) return notReady()
    const o = typeof input === 'string' ? { file: input } : optionsOf(input)
    if (o.file) {
      try {
        return await importBrain({ file: o.file, store: s, log })
      } catch (e) {
        return { ok: false, reason: errText(e) }
      }
    }
    return {
      ok: true,
      ...worldSummary(s),
      threads: worldThreads(s, { limit: Number(o.limit) || 5 }),
    }
  }
  world.import = async (file) => {
    const s = await live()
    if (!s) return notReady()
    if (!file) return { ok: false, reason: '要给我 brain.json' }
    try {
      return await importBrain({ file, store: s, log })
    } catch (e) {
      return { ok: false, reason: errText(e) }
    }
  }
  world.summary = async () => {
    const s = await live()
    return s ? { ok: true, ...worldSummary(s) } : notReady()
  }
  world.threads = async (opts = {}) => {
    const s = await live()
    return s ? { ok: true, threads: worldThreads(s, opts) } : notReady()
  }

  /** 自学：给哪个库就在哪个库上跑（第二库的夜间不能读/写主库的问题）。 */
  async function learnOnStore(s, opts = {}) {
    if (!s) return notReady()
    const o = optionsOf(opts)
    const out = await learnFromStore({
      store: s,
      now: Number(o.now) || Date.now(),
      maxQuestions: o.maxQuestions,
      fetchImpl: o.fetchImpl,
      log,
    })
    return out ?? notReady()
  }

  async function learn(opts = {}) {
    const s = await live()
    if (!s) return notReady()
    return learnOnStore(s, opts)
  }

  async function verify(opts = {}) {
    const s = await live()
    if (!s) return notReady()
    const o = optionsOf(opts)
    return verifyDreams({
      store: s,
      now: Number(o.now) || Date.now(),
      windowDays: o.windowDays,
      maxAgeDays: o.maxAgeDays,
      minOverlap: o.minOverlap,
      log,
    })
  }

  /** 第八道闸的旁路复审：宿主有 llm 且配了 card.reviewModel 才开。 */
  function makeReviewer() {
    let llm = null
    try {
      llm = (typeof safeCtx.get === 'function' ? safeCtx.get('llm') : null) || safeCtx.llm || null
    } catch {
      llm = null
    }
    const rm = cfg.card?.reviewModel
    if (!llm || !rm?.provider || !rm?.model) return null
    return {
      async ask(prompt) {
        const text = String(prompt ?? '')
        if (typeof llm.ask === 'function') {
          return String(await llm.ask(text, { provider: rm.provider, model: rm.model, maxTokens: 120 }))
        }
        if (typeof llm.stream === 'function') {
          let out = ''
          const stream = llm.stream({
            provider: rm.provider,
            model: rm.model,
            maxTokens: 120,
            messages: [{ role: 'user', content: text }],
          })
          for await (const chunk of stream) {
            if (chunk == null) continue
            if (typeof chunk === 'string') {
              out += chunk
              continue
            }
            out += String(
              chunk.text ??
                chunk.delta ??
                chunk.content ??
                chunk?.choices?.[0]?.delta?.content ??
                '',
            )
          }
          return out
        }
        throw new Error('宿主没有可用的 llm.stream')
      },
    }
  }

  /**
   * 夜间模型是显式 opt-in：只有 cfg.nightly.model.enabled === true 才碰本地模型。
   * 默认不拉、不猜本地有没有模型——ollama 不在时归因逐条等 20s，40 次就是十几分钟（n39）。
   * 探活只做一次（3s 超时）；失败就一直用 null（只用规则），成功才建模型并重建 nightly。
   * `probe` / `create` 两个键只给测试注入用，生产配置别填。
   */
  function startNightlyProbe() {
    if (nightlyProbed) return
    nightlyProbed = true
    const mcfg = cfg.nightly?.model && typeof cfg.nightly.model === 'object' ? cfg.nightly.model : {}
    const { probe: probeImpl, create: createImpl, enabled: _enabled, ...modelOpts } = mcfg
    const probe = typeof probeImpl === 'function' ? probeImpl : probeLocalModel
    const create = typeof createImpl === 'function' ? createImpl : createLocalModel
    void (async () => {
      try {
        // 固定 3s：别用 model 的 20s——探活就是为了不每条都等超时。
        const r = await probe({ ...modelOpts, timeoutMs: 3000 })
        if (!r?.ok) {
          log('本地模型不在，夜间只用规则')
          return
        }
        nightlyModel = create(modelOpts)
        // 探活回来之前创建的实例拿的是 null；重建一次，后续 run 才用得上模型。
        nightlyInsts.clear()
        log('本地模型已就绪，夜间可以用它')
      } catch (e) {
        log(`本地模型不在，夜间只用规则（${errText(e)}）`)
      }
    })()
  }

  /** 主库（鲸歌）的夜间实例：参数、模型、客厅吸收都和以前完全一致。 */
  function mainNightly() {
    if (cfg.nightly?.enabled === false) return null
    const s = store
    if (!s || (typeof s.isOpen === 'function' && !s.isOpen())) return null
    let inst = nightlyInsts.get('main')
    if (!inst) {
      const ncfg = cfg.nightly || {}
      const wantsModel = ncfg.model?.enabled === true
      if (wantsModel && !nightlyModel) startNightlyProbe()
      // 没显式打开、或探活还没成功：传 null，夜间只跑规则。
      const model = wantsModel ? nightlyModel : null
      inst = createNightly({
        store: s,
        log,
        config: ncfg,
        model,
        learn: (o) => service.learn(o),
        mind: mindInst,
        // 客厅记录默认「完全手动」：夜里不自动吸，只认邀请码（n195）。
        // 想恢复夜间自动吸收，把 settings 的 room.autoAbsorb 打开。
        roomAbsorb: cfg.room?.autoAbsorb === true ? (o) => absorbRoomLogs(o) : null,
      })
      // 只读快照，给测试/面板看这次夜间用的是哪个模型（不是 nightly 契约的一部分）。
      try {
        inst.model = model
      } catch {
        /* 冻结对象就算了 */
      }
      nightlyInsts.set('main', inst)
    }
    return inst
  }

  /**
   * 第二库（banks/pisces）的夜间实例：只在选项 3 + together 时存在。
   * - store / mind 都是她自己的：归因、分流、梦、核实都不碰主库；
   * - learn 也必须落在她自己的库上（不能借主库的 service.learn）；
   * - 客厅吸收归主库那一趟管，这里不重复吸。
   */
  function piscesNightly() {
    if (cfg.nightly?.enabled === false) return null
    const b = piscesBank
    if (!b || (typeof b.isOpen === 'function' && !b.isOpen())) return null
    let inst = nightlyInsts.get('pisces')
    if (!inst) {
      const ncfg = cfg.nightly || {}
      const wantsModel = ncfg.model?.enabled === true
      if (wantsModel && !nightlyModel) startNightlyProbe()
      const model = wantsModel ? nightlyModel : null
      inst = createNightly({
        store: b,
        log,
        config: ncfg,
        model,
        learn: (o) => learnOnStore(b, o),
        mind: piscesMindInst || getPiscesMind(b),
        roomAbsorb: null,
      })
      try {
        inst.model = model
      } catch {
        /* 冻结对象就算了 */
      }
      nightlyInsts.set('pisces', inst)
    }
    return inst
  }

  /** 按库取夜间实例；不带参数仍是主库（service.nightly / 面板 / 体检都走这一条）。 */
  function getNightly(bank = 'main') {
    return bank === 'pisces' ? piscesNightly() : mainNightly()
  }

  async function checkNightly() {
    try {
      const nightly = getNightly()
      if (!nightly) return
      const due = nightly.due({})
      if (!due?.ok) return
      const r = await nightly.run({})
      if (r?.ran) log(`夜间流水线跑完：${r.steps ? Object.keys(r.steps).join('/') : ''}`)
    } catch (e) {
      log(`夜间流水线失败：${errText(e)}`)
    }
  }

  function startNightlyTimer() {
    if (cfg.nightly?.auto === false) return
    if (nightlyTimer) return
    nightlyTimer = setInterval(() => {
      void checkNightly()
    }, NIGHTLY_TICK_MS)
    nightlyTimer.unref?.()
  }

  /** 主库多久没动静算空闲；宿主 config.pisces.idleQuietMs 可以覆盖（测试也用它）。 */
  function idleQuietMs() {
    const n = Number(cfg.pisces?.idleQuietMs)
    return Number.isFinite(n) && n > 0 ? n : IDLE_QUIET_MS
  }

  /**
   * 空闲整理的第二库夜间：定时器每 10 分钟问一次，全部满足才跑。
   * 条件（lib/idle-nightly.js 的纯函数）：选项 3 + together、设置 pisces.idleNightly、
   * 不在 02:00–05:00、主库最后事件 ≥ 20 分钟、第二库今天没跑过、没有正在跑的。
   * 单飞：idleRunning 期间再来一次直接跳过；失败只 log，不影响主库。
   */
  async function checkIdlePiscesNightly({ now = Date.now() } = {}) {
    const at = Number(now) || Date.now()
    // 1. 开关：先看设置/开局，单库模式在这里就返回，连库都不碰。
    let setup = null
    try {
      setup = readSetup(root)
    } catch {
      setup = null
    }
    let settingOn = false
    try {
      settingOn = readSettings(root)?.pisces?.idleNightly === true
    } catch {
      settingOn = false
    }
    const enabled = setup?.together === true && settingOn
    if (!enabled) {
      return { ...shouldRunIdle({ now: at, enabled: false }), ran: false }
    }
    if (idleRunning) return { ...shouldRunIdle({ now: at, enabled: true, busy: true }), ran: false }

    // 2. 窗口 / 主库最后事件 / 第二库今天跑过没有。
    const inWindow = inNightlyWindow(at, cfg.nightly?.window || NIGHTLY_WINDOW)
    let lastMainEventAt = null
    let inst = null
    let alreadyRanToday = false
    try {
      const main = await live()
      const ev = typeof main?.last === 'function' ? main.last() : null
      const ts = Number(ev?.ts)
      if (ev && Number.isFinite(ts) && ts > 0) lastMainEventAt = ts
    } catch {
      lastMainEventAt = null
    }
    try {
      const b = await ensurePiscesBank()
      if (b) {
        alreadyRanToday = ranNightlyToday(b, at)
        inst = getNightly('pisces')
      }
    } catch (e) {
      log(`派希丝单独整理：第二库没打开（${errText(e)}）`)
      inst = null
    }
    const verdict = shouldRunIdle({
      now: at,
      lastMainEventAt,
      alreadyRanToday,
      inWindow,
      busy: idleRunning,
      enabled: Boolean(enabled && inst),
      quietMs: idleQuietMs(),
    })
    if (!verdict.ok) return { ...verdict, ran: false }

    // 3. 单飞执行：force 跳窗口/今天跑过（上面已经判过），顺序跑，不和别人并发。
    idleRunning = true
    try {
      const r = await inst.run({ now: at, force: true })
      if (r?.ran) log(`派希丝单独整理跑完：${r.steps ? Object.keys(r.steps).join('/') : ''}`)
      return r
    } catch (e) {
      log(`派希丝单独整理失败：${errText(e)}`)
      return { ok: false, ran: false, reason: errText(e) }
    } finally {
      idleRunning = false
    }
  }

  function startIdlePiscesNightly() {
    if (idleTimer) return
    idleTimer = setInterval(() => {
      void checkIdlePiscesNightly().catch((e) => log(`派希丝单独整理失败：${errText(e)}`))
    }, NIGHTLY_TICK_MS)
    idleTimer.unref?.()
  }

  /** 设置中心：每次都现读文件（面板打开时要看到刚存的值，而不是启动快照）。 */
  function settingsInfo() {
    // publicSettings：隐藏项（persona.guard）既不进 schema，也不从接口回值。
    return { ok: true, settings: publicSettings(readSettings(root)), schema: SETTINGS_SCHEMA, root }
  }

  /** 写设置：校验与落盘在 lib/settings.js；needsRestart 只含 SCHEMA 里 restart:true 的项。 */
  async function saveSettings(patch) {
    const r = writeSettings(root, patch)
    if (!r.ok) return r
    const out = { ok: true, settings: publicSettings(r.settings), changed: r.changed || [], needsRestart: r.needsRestart || [] }
    if (r.ignored) out.ignored = r.ignored
    if (r.note) out.note = r.note
    return out
  }

  /** 贴吧登录状态：只读本地文件（保存时已经验过一次，不每次开面板都联网）。 */
  async function baiduStatus() {
    const saved = readBaidu(root)
    if (!saved) return { ok: true, loggedIn: false, name: null, hasCookie: false }
    return { ok: true, loggedIn: true, name: saved.name || null, hasCookie: true }
  }

  /** 贴吧登录：粘贴 cookie → 验证 → 落盘；失败原因由 lib/baidu.js 给，不打印 cookie。 */
  function baiduLogin(text) {
    return loginBaidu({ root, text })
  }

  function baiduLogout() {
    return { ok: true, removed: clearBaidu(root) }
  }

  /** B 站登录状态：只读本地 owner.json（保存时已经验过一次，不每次开面板都联网）。 */
  async function biliStatus() {
    const saved = readBili(root)
    if (!saved) return { ok: true, loggedIn: false, name: null, hasCookie: false }
    return { ok: true, loggedIn: true, name: saved.name || null, hasCookie: true }
  }

  /** B 站登录：粘贴 SESSDATA/bili_jct → 验证 → 落盘；失败原因由 lib/bili.js 给，不打印 cookie。 */
  function biliLogin(text) {
    return loginBili({ root, text, log })
  }

  function biliLogout() {
    return { ok: true, removed: clearBili(root) }
  }

  /**
   * B 站扫码登录：生成码 → 轮询 → （人点保存）才落盘。
   * 四个动作都在 lib/biliqr.js 的状态机里；这里只把 root 和库边界接上。
   */
  function biliQrStart() {
    return qrLogin.start()
  }

  function biliQrPoll(key) {
    return qrLogin.poll(key)
  }

  async function biliQrSave(key) {
    return qrLogin.save(key, root)
  }

  function biliQrDrop(key) {
    return qrLogin.drop(key)
  }

  /**
   * 语音回复状态：只回有没有适配器、是哪种。
   * available 同时受隐藏开关约束；没有适配器时恒为 false（宿主现在就是这样）。
   */
  function voiceInfo() {
    const available = Boolean(voiceAdapter?.ok) && voiceEnabled
    return { ok: true, available, kind: available ? voiceAdapter.kind : null }
  }

  /**
   * 条件触发：只有「用户这条是语音」且「有适配器」且「开关没关」才合成。
   * 他打字时回固定 reason，不生成文件；合成失败也只回 `{ok:false, reason}`。
   * 未来 QQ/微信桥接这一条：传 {text: 她要说的, input: 收到的消息}，拿 {file, mime} 发出去。
   */
  async function voiceReply(input = {}) {
    const o = optionsOf(input)
    const text = textOf(input)
    const heard = o.input !== undefined ? o.input : o
    if (!shouldReplyWithVoice({ adapter: voiceAdapter, input: heard, enabled: voiceEnabled })) {
      return { ok: false, reason: '他用文字说的，不用语音回' }
    }
    return synthesizeToFile({ adapter: voiceAdapter, text, outDir: join(root, VOICE_DIR), format: voiceFormat })
  }

  const service = {
    ready,
    root,
    paths: p,
    settings: settingsInfo,
    setSettings: saveSettings,
    baiduStatus,
    baiduLogin,
    baiduLogout,
    biliStatus,
    biliLogin,
    biliLogout,
    biliQrStart,
    biliQrPoll,
    biliQrSave,
    biliQrDrop,
    // 语音回复：状态 + 条件触发。不进面板；未来桥只调 voiceReply。
    voice: voiceInfo,
    voiceReply,
    recall,
    remember,
    ask,
    cardPatch,
    // 开发者能力只在开发版挂到 service 上；发布版连属性都不出现（n74）。
    ...(isRelease
      ? {}
      : {
          // 开发者带钥匙直写卡（绕闸，但抬头/长度仍强制，落 dev:true 的 card_patch）。
          devCard,
          devkey,
          rotateDevkey,
          deleteDevkey,
        }),
    diary,
    seed,
    writeSeed,
    adopt,
    setup: setupStart,
    setupInfo,
    welcome: welcomeInfo,
    demoInfo,
    nickname,
    setNickname,
    // 固定段的文件覆盖：下一轮 attach 现读，不用重启。
    fixed,
    setFixed,
    clearFixed,
    // 家的调试入口：返回 ensureHome 的结果（幂等，重复调不新建）。
    home: () => ensureHomeOnce(),
    learn,
    verify,
    state,
    // 派希丝第二库的同一份状态（面板「看谁」切换用）。
    piscesState,
    derive,
    exportCard,
    exportSoul,
    importFish,
    importSoul,
    world,
    get nightly() {
      return getNightly()
    },
    // 空闲整理的一次判定/执行：定时器每 10 分钟调它；测试/面板也能手动触发（单飞）。
    idleNightly: checkIdlePiscesNightly,
    // 给面板/别的插件用的只读概览；不在契约里，但保留旧实现的出口。
    async observe() {
      const s = await live()
      if (!s) return notReady()
      const events = s.readAll() || []
      return {
        ok: true,
        day: deriveSelf(events).day,
        events: events.length,
        questions: listQuestions(s, { status: 'open', limit: 50 }).length,
        dreams: events.filter((e) => e.type === 'dream_sim' && e.meta?.status !== 'rejected').length,
        verified: events.filter((e) => e.meta?.kind === 'dream_observed').length,
      }
    },
  }

  // 6. 旧实现的服务名就是 persona；没有 provide 就只记一行。
  try {
    if (typeof safeCtx.provide === 'function') {
      safeCtx.provide('persona', service)
      log('persona 服务已注册')
    } else {
      log('没有 ctx.provide，persona 服务跳过')
    }
  } catch (e) {
    log(`注册 persona 服务失败：${errText(e)}`)
  }

  // 7. 工具面：放在 ready.then 里（演示标记要等库打开）；getStore 必须是 live()。
  if (cfg.tools !== false) {
    ready.then(async (s) => {
      try {
        let st = s
        if (!st) {
          try {
            st = await ensureLive()
          } catch (e) {
            log(`按需开库失败：${errText(e)}`)
          }
        }
        // 成年鱼标记只能在库打开后读事件流才知道（n26/n28）；任务契约里的 demo 探测。
        let evs = []
        try {
          evs = st ? st.readAll() || [] : []
        } catch {
          evs = []
        }
        const adult = isDemo(evs)
        // 发布标记交给 tools.js 兜底：即使依赖手滑传进来，release=true 也不注册 pisces_dev。
        const toolDeps = {
          isRelease,
          getStore: () => live(),
          log,
          patchCard: (args) => service.cardPatch(args),
          rec: (o) => service.recall(o),
          // B 站：look 只读公开热门；speak 的开关在 lib/speak.js 里判（cfg.bili.speak===true），
          // 所以 cfg 要传整份配置（speakEnabled 读的是 cfg.bili.speak，不是 cfg.speak）。
          // 关着时回执是「说话功能没开」，普通鱼的工具面仍是 7 个（n23）。
          look: (o) => hot({ limit: o?.limit }),
          speak: (o) => speakOnBili({ root, bvid: o?.bvid, text: o?.text, cfg, log }),
          // 成年鱼四个特权动作的依赖；普通鱼 demo=null，tools.js 不会注册它们。
          selfView: async () => {
            const s2 = await live()
            if (!s2) return { ok: false, reason: 'not-ready' }
            const d = deriveSelf(s2.readAll() || [])
            let split = false
            try {
              const desc = (await getMind())?.describe?.() || null
              split = desc?.splitAt != null
            } catch {
              split = false
            }
            // 只给天数与四个计数；dominance / 权重 / order 一律不出现在自查里。
            return {
              ok: true,
              view: {
                day: d.day,
                beliefs: d.beliefs.length,
                refusals: d.refusals.length,
                scars: d.scars.length,
                split,
              },
            }
          },
          teach: (topic) => teachFor(topic),
          // 新手引导直接用 lib/guide.js（纯函数）；状态从这里递进去，读不到就 null。
          guide,
          guideState: async () => {
            const st = await service.state()
            if (!st || st.ok === false) return null
            let hasSeed = false
            try {
              const s2 = await live()
              hasSeed = (s2?.readAll?.() || []).some((e) => e?.type === 'seed')
            } catch {
              hasSeed = false
            }
            return { hasSeed, events: st.events, tier: st.affinity?.tier ?? 0 }
          },
          // 体检读库与状态，失败也不抛。
          check: () => checkup(),
          // 昵称：她给自己记一个称呼（固定名字仍是派希丝，事件流追加，取最后一条）。
          setNickname: (name) => service.setNickname(name),
          // 成年鱼标记：发布版没有 devkey，所以 12 个动作；开发版 13 个（n74）。
          demo: adult
            ? {
                selfInspect: true,
                teach: true,
                guide: true,
                check: true,
                nickname: true,
                ...(isRelease ? {} : { devkey: true }),
              }
            : null,
        }

        // 表情包：关掉就不注册这个动作（和 look/speak 一样，缺依赖就少一个工具）。
        if (cfg.meme?.enabled !== false) toolDeps.selectMeme = (o) => selectMeme(o)

        // 开发者依赖只在开发版注入；发布包里这几个键一个都不出现（n74）。
        if (!isRelease) {
          Object.assign(toolDeps, {
            // 开发者直接写卡：绕八道闸，但抬头/长度仍由 card.js 强制。
            devCard: (args) => service.devCard(args),
            // 开发者只读查询：看卡原文 / 看运行时固定段原文；都不写任何东西。
            readCardSelf: (agent) => readCardSelf(agent),
            personaText: () => FIXED_PERSONA,
            // 固定段的文件覆盖（<root>/persona-fixed.md）：读现状 / 整段写 / 删掉回默认。
            fixedGet: () => service.fixed(),
            fixedSet: ({ text } = {}) => service.setFixed(text),
            fixedClear: () => service.clearFixed(),
            // 看她自己怎么想（pisces_dev 的 trace）：读库 + 分流 + 派生 + 好感 + 悬着的问题，
            // 折成一段人话；格式化是 tools.js 的纯函数 buildTrace，这里只负责取数。
            trace: async ({ limit } = {}) => {
              const s = await live()
              if (!s) throw new Error('库没读到')
              let events = []
              try {
                events = s.readAll() || []
              } catch {
                throw new Error('库没读到')
              }
              const derived = deriveSelf(events)
              let mind = {}
              try {
                mind = (await getMind())?.describe?.() || {}
              } catch {
                mind = {}
              }
              let questions = []
              try {
                questions = listQuestions(s, { status: 'open', limit: 50 })
              } catch {
                questions = []
              }
              let attrib = []
              try {
                attrib = s.attribAll?.() || []
              } catch {
                attrib = []
              }
              let affinity = null
              try {
                let allQuestions = []
                try {
                  allQuestions = s.questionAll?.() || []
                } catch {
                  allQuestions = []
                }
                affinity = computeAffinity({ events, questions: allQuestions, now: Date.now() })
              } catch {
                affinity = null
              }
              return buildTrace({ events, derived, mind, affinity, questions, attrib, limit })
            },
            // 看完整状态（pisces_dev 的 state）：同一批数据但不过 reveal 遮罩，读全部事件；
            // 取数与格式化在 fullState() 里，没有库/读失败回人话。
            devState: () => fullState(),
            // 开发者钥匙：工具先验根目录下的 devkey.json；只给成年鱼。
            verifyDevkey: (key) => {
              try {
                return devkeyMod?.verifyDevkey?.(root, key) === true
              } catch {
                return false
              }
            },
          })
        }
        const r = registerTools(safeCtx, toolDeps)
        log(r?.ok ? `工具面已注册：${r.count} 个动作` : '没有 tools 服务，工具面跳过')
      } catch (e) {
        log(`注册工具面失败：${errText(e)}`)
      }
    })
  }

  // 8. 提示词桥：默认开（attachToAgents !== false），但只挂「她屋里」那条会话。
  //
  // 为什么不能全挂：写代码的会话不该带上「你存在了几天」，更不该被反破甲提醒。
  // 判据两条，任一为真：
  //   1. cwd 在 <root>/home 之下 —— 主判据。会话刚建好时 home.json 可能还没写，
  //      cwd 已经在了（解决 create → home.json 落盘的竞态）。
  //   2. 会话 id === home.json 的 sessionId —— 兜住宿主没给 cwd 的情况；
  //      读不到 home.json 就跳过这条判据，不影响启动。
  // 两条都不满足 → 不挂。
  if (cfg.attachToAgents !== false) {
    const homeFile = join(root, HOME_FILE)
    /** 家目录：home.json 的 workspacePath 优先（搬家后 living 就是她家）；没有就退回 <root>/home。 */
    const readHomeWorkspace = () => {
      try {
        const raw = readFileSync(homeFile, 'utf8').replace(/^\uFEFF/, '')
        const j = JSON.parse(raw)
        return String(j?.workspacePath ?? j?.cwd ?? '')
      } catch {
        return ''
      }
    }
    const herHome = readHomeWorkspace() || join(root, 'home')
    /** 每次现读：home.json 可能在插件启动之后才由 ensureHome 写出来。 */
    const readHomeSessionId = () => {
      try {
        const raw = readFileSync(homeFile, 'utf8').replace(/^\uFEFF/, '')
        const j = JSON.parse(raw)
        return String(j?.sessionId ?? '')
      } catch {
        return ''
      }
    }
    /**
     * 她屋里开过的会话 id。宿主 llm/stream 的 options 只带 sessionId——真机
     * buildRequest 里只有 config/messages/toolHistory/tools/sessionId/signal，
     * 没有 cwd，所以落库判据没法从 options 反推 cwd。只能在 agent/created
     * 判通过时把 sid 记下来；n77 的门控不放松：只记 shouldAttach 通过的会话。
     * 只增不删，上限 200 条，超出丢最老的（最近用过的会被重新提到队尾）。
     */
    const herSessionIds = new Set()
    const rememberHerSession = (sid) => {
      if (!sid) return
      herSessionIds.delete(sid)
      herSessionIds.add(sid)
      while (herSessionIds.size > 200) herSessionIds.delete(herSessionIds.values().next().value)
    }
    const shouldAttach = (agent) => {
      try {
        const cwd = flatPath(cwdOf(agent))
        const home = flatPath(herHome)
        const sid = sidOf(agent)
        if (cwd && home && (cwd === home || cwd.startsWith(`${home}/`))) {
          rememberHerSession(sid)
          return true
        }
        if (!sid) return false
        const saved = readHomeSessionId()
        if (!saved || sid !== saved) return false
        rememberHerSession(sid)
        return true
      } catch {
        // 判据失败最多是不挂，不能拖垮启动。
        return false
      }
    }

    // 客厅：只在她屋里那条会话里接管；room.enabled 默认 false。
    // 没有 setup.json 就不接（开局三选项还没选），普通家会话照旧。
    let roomRuntime = null
    if (cfg.room?.enabled === true) {
      try {
        const setup = readSetup(root)
        if (!setup) {
          log('客厅：没有 setup.json，先不接')
        } else {
          // 根 ctx 未必直接有 llm；双流也是 inject(['llm']) 才拿到。
          // 先拿/注入；拿到之前也把 3 连挂上，正常回合等 llm 到了再走。
          let roomLlm = null
          const pickLlm = (c) => {
            try {
              const l = c?.llm ?? (typeof c?.get === 'function' ? c.get('llm') : null)
              if (l && typeof l.stream === 'function') roomLlm = l
            } catch {
              /* 探测失败：继续等注入 */
            }
            return roomLlm
          }
          pickLlm(safeCtx)
          if (!roomLlm && typeof safeCtx.inject === 'function') {
            try {
              safeCtx.inject(['llm'], (sub) => {
                if (!pickLlm(sub)) log('客厅：注入的 llm 没有 stream')
                // 必须把 disposer 交回去：返回 undefined 会让注入的子 ctx 当场被回收，
                // 之后 llm.stream 只剩空流（就是“连上了但没人说话”的那个样子）。
                return () => {}
              })
            } catch (e) {
              log(`客厅：取 llm 失败（${errText(e)}）`)
            }
          }
          if (!roomLlm) log('客厅：llm 还没就绪，先挂欢迎；正常回合等 llm 到了再走')
          const piscesRoomSystem = () => {
            const { adult, ordinary } = getCast()
            return [
              fixedPersonaFor({ adult, ordinary }),
              relationLines({ demo: true }),
              `[客厅] 你是${adult.label}，${ordinary.name}是你${ordinary.label}。只回一句；不替${ordinary.label}说；客厅只聊天，不用工具。`,
            ].join('\n\n')
          }
          const fishRoomSystem = () => {
            if (!store) return ''
            try {
              const events = store.readAll?.() || []
              const nickname = nicknameOf(events)?.name ?? null
              const built = buildSections({
                store,
                config: cfg.mind || {},
                now: Date.now(),
                demo: false,
                nickname,
                fixedText: null,
              })
              return (built?.sections || [])
                .map((sec) => (typeof sec.text === 'function' ? sec.text() : sec.text))
                .filter(Boolean)
                .concat([
                  // 客厅里的名字说明：她的妹妹在客厅叫「鲸漪」（同一个人的本名是派希丝）。
                  (() => {
                    const { adult, ordinary } = getCast()
                    return `[客厅] 你妹妹在客厅里叫${adult.name}；你是${ordinary.name}（${ordinary.label}）。只回一句，客厅只聊天，不用工具。`
                  })(),
                ])
                .join('\n\n')
            } catch (e) {
              log(`客厅：组装普通鱼提示词失败（${errText(e)}）`)
              return ''
            }
          }
          roomRuntime = createRoomRuntime({
            getLlm: () => roomLlm,
            getSetup: () => readSetup(root),
            saveSetup: (next) => writeSetup(root, next),
            getStore: () => store,
            // 门票：去客厅要通行码（贴进客厅即开门 90 分钟）；回来说一声就行。
            roomTicket: {
              consume: (text) => Boolean(consumeInvite(root, text, { role: 'room' })),
              open: () => openTicket(root),
              active: () => Boolean(readTicket(root)),
            },
            // 卡在哪一步要落盘：宿主整个卡死时 /state 读不到、重启后计数又清零，
            // 只有这行文件能事后看（只写阶段/时长/错误，不写正文）。
            writeTrace: (patch) => {
              try {
                writeFileSync(join(root, 'room', 'last-turn.json'), `${JSON.stringify(patch)}\n`)
              } catch {
                /* 留痕失败不影响客厅 */
              }
            },
            fishSystem: fishRoomSystem,
            piscesSystem: piscesRoomSystem,
            onTurn: async ({ user, text, teaching }) => {
              try {
                const { fish, pisces } = splitRoom(text)
                appendRoomLog(root, { user, fish, pisces, teaching: teaching?.id ?? null })
              } catch (e) {
                log(`客厅日志没写进去：${errText(e)}`)
              }
            },
            log,
          })
          log(`客厅已挂上：${setup.mode}${setup.together ? '（两库）' : ''}`)
          roomInfoGetter = () => roomRuntime?.info?.() ?? null
        }
      } catch (e) {
        log(`客厅：初始化失败（${errText(e)}），走普通生成`)
        roomRuntime = null
      }
    }

    try {
      // 人设段：鲸歌家和客厅共用；每轮现读事件流判 demo / 昵称 / 固定段覆盖。
      const buildSectionsForHer = (args = {}) => {
        let demo = false
        let nickname = null
        let devOverlay = null
        let fixedText = null
        try {
          const events = args?.store?.readAll?.() || []
          demo = isDemo(events)
          nickname = nicknameOf(events)?.name ?? null
          // 开发者钥匙改出来的人设：最后一条 dev-persona，文本为 null 就是清空了。
          // 发布版没有钥匙，事件流里残留的 dev-persona 也不挂段（n74）。
          devOverlay = isRelease ? null : devOverlayOf(events)
          fixedText = readFixedOverride(root)
        } catch {
          demo = false
          nickname = null
          devOverlay = null
          fixedText = null
        }
        return buildSections({ ...args, demo, nickname, devOverlay, fixedText })
      }
      const guardDeps = cfg.guard?.enabled !== false ? { scanGuard: (text) => scan(text) } : {}
      const devkeyDeps = isRelease
        ? {}
        : {
            isDevkey: (text) => {
              try {
                return devkeyMod?.verifyDevkey?.(root, text) === true
              } catch {
                return false
              }
            },
          }

      // 鲸歌的家：只私聊；客厅不再挂在这里。
      attachOff = attachToAgents(safeCtx, {
        getStore: () => live(),
        buildSections: buildSectionsForHer,
        ...guardDeps,
        ...devkeyDeps,
        shouldAttach,
        // 聊天落库的门控：llm/stream 是全局 waterfall，别的会话的生成也会经过观察器。
        // 只有她屋里那条会话才记 heard/utterance：home.json 的 sessionId，或 shouldAttach
        // 通过时记下的会话 id（她家工作区里新开的会话靠这一条——宿主 options 只有
        // sessionId、没有 cwd；key 的 cwd 分支只是宿主不给 sid 时的老兜底）。
        // 每次现读 home.json，读不到 → 只认记下的会话。shouldAttach 只管挂人设段。
        isHerSession: (sid, key) => {
          if (sid && sid === readHomeSessionId()) return true
          // agent/created 判通过时记下的会话：只增不删、上限 200（见 herSessionIds）。
          if (sid && herSessionIds.has(sid)) return true
          // 宿主没给 sessionId 时 attach 会退回 cwd 当会话 key：家目录（living）下的会话也算她屋里。
          if (key && String(key).startsWith('cwd:')) {
            const cwd = flatPath(String(key).slice(4))
            const home = flatPath(herHome)
            if (cwd && home && (cwd === home || cwd.startsWith(`${home}/`))) return true
          }
          return false
        },
        // 回来：各自家里说「我回来了」就吸收（不用码）；去客厅要通行码（n195）。
        roomBack: backAbsorber('ordinary'),
        roomRuntime: null,
        config: cfg,
        log,
      })

      // 客厅：独立工作区（<root>/room/home.json），只接客厅会话。
      if (roomRuntime) {
        const roomSessionIds = new Set()
        const rememberRoom = (sid) => {
          if (!sid) return
          roomSessionIds.delete(sid)
          roomSessionIds.add(sid)
          while (roomSessionIds.size > 200) roomSessionIds.delete(roomSessionIds.values().next().value)
        }
        const roomHomeOf = () => String(readRoomHome(root)?.workspacePath ?? readRoomHome(root)?.cwd ?? roomHomePaths(root).dir)
        const roomSidOf = () => String(readRoomHome(root)?.sessionId ?? '')
        const inRoomHome = (cwd) => {
          const c = flatPath(cwd)
          const h = flatPath(roomHomeOf())
          return Boolean(c && h && (c === h || c.startsWith(`${h}/`)))
        }
        attachRoomOff = attachToAgents(safeCtx, {
          getStore: () => live(),
          buildSections: buildSectionsForHer,
          ...guardDeps,
          ...devkeyDeps,
          shouldAttach: (agent) => {
            try {
              const sid = sidOf(agent)
              if (inRoomHome(cwdOf(agent))) {
                rememberRoom(sid)
                return true
              }
              if (sid && sid === roomSidOf()) {
                rememberRoom(sid)
                return true
              }
              return false
            } catch {
              return false
            }
          },
          isHerSession: (sid, key) => {
            if (sid && sid === roomSidOf()) return true
            if (sid && roomSessionIds.has(sid)) return true
            if (key && String(key).startsWith('cwd:')) return inRoomHome(String(key).slice(4))
            return false
          },
          roomRuntime,
          config: cfg,
          log,
        })
      }
    } catch (e) {
      log(`挂提示词桥失败：${errText(e)}`)
    }
  }

  // 9. 双流：只有明确 enabled 才注册 llm/stream。
  if (cfg.dual?.enabled === true) {
    try {
      const mode = upperOf(cfg.dual.mode || 'A') === 'B' ? 'B' : 'A'
      dualOff = attachDual(safeCtx, {
        enabled: true,
        mode,
        cfg: cfg.dual,
        log,
      })
      log(`双流已挂上：${mode} 档`)
    } catch (e) {
      log(`挂双流失败：${errText(e)}`)
    }
  }

  // 10. 观测台：deps 里 service 方法原样传（闭包持库），不要传 lib 函数（n42）。
  function consoleDeps() {
    return {
      // getter：宿主重开库后不要钉死在旧实例上。
      get store() {
        if (store && (typeof store.isOpen !== 'function' || store.isOpen())) return store
        return ensureLive()
      },
      get mind() {
        return mindInst;
      },
      // 诊断用：提示词桥到底挂没挂上（agentsSeen/sectionsAttached/agentsNotHer…）。
      bridge: () => (attachOff?.info ?? null),
      // 第二条 attach（她单独家那条）的同一份快照：/bridge?bank=pisces 用。
      piscesBridge: () => (piscesSoloOff?.info ?? null),
      // 输出侧语料标记：只给计数，不给原文（n12）。
      style: () => (attachOff?.info?.streamDebug ?? null),
      get nightly() {
        return getNightly()
      },
      get dual() {
        return dualOff?.stats?.() ?? null
      },
      // service 的完整状态（面板要的 demo 就在这里：成年鱼 {name,label}，普通鱼 null）。
      state: service.state,
      // 派希丝的第二库：面板「看谁」切到她时读这些（只读工具面）。
      piscesState: service.piscesState,
      piscesStore: () => ensurePiscesBank(),
      demoInfo: service.demoInfo,
      nickname: service.nickname,
      setNickname: (name) => service.setNickname(name),
      // 开发者钥匙：只在开发版给路由；发布版三个键都不出现 → /devkey 回 404（n74）。
      ...(isRelease
        ? {}
        : {
            // 开发者钥匙：GET 只回 hasKey；POST 只在这一次回明文；DELETE 删文件。
            devkey: () => service.devkey(),
            rotateDevkey: () => service.rotateDevkey(),
            deleteDevkey: () => service.deleteDevkey(),
          }),
      // 设置中心：GET /settings 读、POST /settings 写（写入口自己带 schema 校验）。
      settings: () => service.settings(),
      saveSettings: (patch) => service.setSettings(patch),
      // 语音回复：只给桥/面板读状态（available/kind）；不往面板加 UI。
      voice: () => service.voice(),
      // 百度贴吧登录：GET /baidu 只回状态，POST /baidu 粘贴验证，DELETE /baidu 清掉。
      baiduStatus: () => service.baiduStatus(),
      baiduLogin: (text) => service.baiduLogin(text),
      baiduLogout: () => service.baiduLogout(),
      // B 站登录：GET /bili 只回状态（绝不回 cookie），POST 粘贴验证，DELETE 清掉。
      biliStatus: () => service.biliStatus(),
      biliLogin: (text) => service.biliLogin(text),
      biliLogout: () => service.biliLogout(),
      // 扫码登录：POST /bili/qr 生成，GET ?key= 轮询，POST /bili/qr/save 保存，drop 取消。
      biliQrStart: () => service.biliQrStart(),
      biliQrPoll: (key) => service.biliQrPoll(key),
      biliQrSave: (key) => service.biliQrSave(key),
      biliQrDrop: (key) => service.biliQrDrop(key),
      readStore: () => ensureLive(),
      // 表情包：GET /meme 只给包清单；GET /meme/<包>/<id>.png 出图（同源）。
      memes: () => memePacks(),
      // 客厅门票：POST 生成/复用一张通行码（贴进客厅 = 开门 90 分钟）；GET 看门开没开、码还剩哪张。
      // 还有没用掉的码就原样返回它——别让「再点一次」把手上那张作废。
      roomInvite: () => {
        const alive = pendingInvites(root).find((x) => String(x && x.role) === 'room')
        return alive || createInvite(root, { role: 'room' })
      },
      roomInvites: () => pendingInvites(root),
      // 面板首卡的权威状态：门开没开、到几点、上次谁回来过（带名字，发布版也是对的）。
      roomDoor: () => {
        const info = readTicketInfo(root)
        const { adult, ordinary } = getCast()
        return {
          open: info.open,
          until: info.until,
          backed: {
            ordinary: { name: ordinary.name, ok: info.backed.ordinary },
            adult: { name: adult.name, ok: info.backed.adult },
          },
        }
      },
      seed: service.seed,
      writeSeed: service.writeSeed,
      adopt: service.adopt,
      setup: service.setup,
      setupInfo: service.setupInfo,
      welcome: service.welcome,
      // 手动触发建家：观测台 POST /home 用（幂等，重试窗口内会等宿主服务）。
      home: service.home,
      learn: service.learn,
      verify: service.verify,
      observe: service.observe,
      exportCard: service.exportCard,
      exportSoul: service.exportSoul,
      questions: {
        list: async (opts) => {
          const s = await live()
          return s ? listQuestions(s, opts) : []
        },
        setStatus: async (key, status) => {
          const s = await live()
          return s ? setQuestionStatus(s, key, status) : notReady()
        },
      },
    }
  }

  // 观测台挂载（n6）：webServer 可能比插件晚就绪——apply 里当场 ctx.get 拿不到就放弃
  // 是真机踩过的坑（/dsh-pisces-api 404）。顺序：inject(['webServer']) 等注入 → 当场取一次
  // → 都没有再用 ctx.effect + 500ms 轮询（最多 10 次，unref），仍没有才 log 没挂上。
  const CONSOLE_POLL_MS = 500
  const CONSOLE_POLL_MAX = 10

  function getWebServer() {
    try {
      return (typeof safeCtx.get === 'function' ? safeCtx.get('webServer') : null) || safeCtx.webServer || null
    } catch {
      return null
    }
  }

  function stopConsolePoll() {
    if (consolePollTimer) {
      clearTimeout(consolePollTimer)
      consolePollTimer = null
    }
  }

  /** 拿到 server 就挂上；没有回 false，由调用方决定等注入还是轮询。 */
  function mountConsole(server) {
    if (cfg.console?.enabled === false) return false
    if (consoleMount?.ok) return true
    const ws = server || getWebServer()
    if (!ws) return false
    try {
      // registerConsole 只认 ctx.get('webServer')；注入拿到的实例通过这层代理交给它。
      const r = registerConsole({ get: (name) => (name === 'webServer' ? ws : null) }, consoleDeps())
      consoleMount = r || { ok: false, reason: 'webServer 注册失败' }
      if (r?.ok) {
        stopConsolePoll()
        log(`观测台已挂上：${CONSOLE_PREFIX}`)
        return true
      }
      // 有 server 但注册失败：log 原因后别再无限重试。
      log(`观测台没挂上：${r?.reason || 'webServer 注册失败'}`)
    } catch (e) {
      consoleMount = { ok: false, reason: errText(e) }
      log(`观测台没挂上：${errText(e)}`)
    }
    return false
  }

  function startConsolePoll() {
    if (cfg.console?.enabled === false) return
    if (consolePollTimer || consoleMount) return
    // 清理登记进宿主生命周期；轮询本体用 setTimeout（effect 不一定同步执行回调）。
    if (typeof safeCtx.effect === 'function') {
      try {
        safeCtx.effect(() => stopConsolePoll, 'dsh-pisces-console-poll')
      } catch {
        /* effect 不可用不影响轮询 */
      }
    }
    const tick = () => {
      if (closed || cfg.console?.enabled === false || consoleMount) return
      consolePollTimer = setTimeout(() => {
        consolePollTimer = null
        if (closed || cfg.console?.enabled === false || consoleMount) return
        consolePollCount += 1
        if (mountConsole()) return
        if (consoleMount) return
        if (consolePollCount >= CONSOLE_POLL_MAX) {
          log('观测台没挂上：没有 webServer')
          return
        }
        tick()
      }, CONSOLE_POLL_MS)
      consolePollTimer.unref?.()
    }
    tick()
  }

  function mountConsoleWhenReady() {
    if (cfg.console?.enabled === false) return
    // 1. 优先注入：webServer 服务晚于插件注册时靠它接上。
    if (typeof safeCtx.inject === 'function') {
      try {
        const ret = safeCtx.inject(['webServer'], (sub) => {
          if (closed || consoleMount?.ok) return
          const ws = sub?.webServer ?? getWebServer()
          if (ws) mountConsole(ws)
        })
        if (typeof ret === 'function') consoleInjectOff = ret
      } catch (e) {
        log(`观测台注入 webServer 失败：${errText(e)}`)
      }
    }
    // 2. 当场能拿到就先挂（inject 回调不保证同步跑）。
    if (mountConsole()) return
    // 3. 两样都没有：轮询等它出现。
    startConsolePoll()
  }

  mountConsoleWhenReady()

  // 夜间模型显式 opt-in：开机就探一次（3s），别等第一次整理才发现模型不在。
  if (cfg.nightly?.enabled !== false && cfg.nightly?.model?.enabled === true) startNightlyProbe()

  // 11. 家：已经领养/写过起点的话，在宿主侧栏里建一个工作区 + 一条会话（幂等）。
  // 只在事件流里有 demo 或 seed 时才建；config.home.enabled === false 时整块跳过。
  // 失败只 log 一行，不阻塞启动——宿主没有这些服务时插件照样跑。
  if (cfg.home?.enabled !== false && cfg.home?.auto !== false) {
    ready.then((s) => {
      if (!s) return
      try {
        const events = s.readAll() || []
        const seeded = events.some((e) => e && e.type === 'seed')
        if (!seeded && !isDemo(events)) return
      } catch (e) {
        log(`家没建好：${errText(e)}`)
        return
      }
      // 不阻塞：重试窗口最长约 20s，别把启动 promise 链拖住（日志顺序也靠它）。
      void ensureHomeOnce().catch((e) => {
        log(`家没建好：${errText(e)}`)
      })
    })
  }

  // 12. 人设卡篡改校验：启动后 await 一次（n9）。
  ready.then(async (s) => {
    if (!s) return
    try {
      const r = await tamperCheck(root, { store: s, log })
      if (Array.isArray(r?.restored) && r.restored.length) {
        log(`人设卡：发现被外面改过，已恢复 ${r.restored.join('、')}`)
      }
    } catch (e) {
      log(`人设卡校验失败：${errText(e)}`)
    }
  })

  // 13. dispose：置 closed、清定时器、摘 attach/dual/console、关库、放锁。
  function dispose() {
    const first = !disposed
    disposed = true
    closed = true
    // 内存里可能还攥着扫码登录的 cookie：停用就清掉，不靠进程退出兜底。
    try {
      qrLogin.clear()
    } catch {
      /* 清不掉就算了 */
    }
    if (first) {
      log(`已停用（apply#${n}）`)
    }
    if (nightlyTimer) {
      clearInterval(nightlyTimer)
      nightlyTimer = null
    }
    if (idleTimer) {
      clearInterval(idleTimer)
      idleTimer = null
    }
    stopConsolePoll()
    for (const off of [attachOff, attachRoomOff, dualOff, consoleMount?.dispose, consoleInjectOff]) {
      if (typeof off !== 'function') continue
      try {
        off()
      } catch {
        /* 摘不到就算了 */
      }
    }
    attachOff = null
    attachRoomOff = null
    roomInfoGetter = null
    dualOff = null
    consoleMount = null
    consoleInjectOff = null
    const s = store
    store = null
    const b = piscesBank
    piscesBank = null
    piscesHome = null
    const solo = piscesSoloOff
    piscesSoloOff = null
    if (typeof solo === 'function') {
      try { solo() } catch { /* 摘不到就算了 */ }
    }
    mindInst = null
    piscesMindInst = null
    nightlyInsts.clear()
    idleRunning = false
    if (b) {
      try {
        b.close()
      } catch {
        /* 已经关了 */
      }
    }
    if (s) {
      try {
        s.close()
      } catch {
        /* 已经关了 */
      }
    }
    releaseLock()
  }

  // 重启：如果开局选了“一同成长”，把派希丝的单独家/第二库接回来（幂等）。
  if (readSetup(root)?.together === true) {
    void ensurePiscesHomeOnce().catch((e) => log(`派希丝单独家启动失败：${errText(e)}`))
  }
  // 客厅自己的家：只在 setup.room 时建；幂等。
  if (readSetup(root)?.room === true) {
    void ensureRoomHomeOnce().catch((e) => log(`客厅启动失败：${errText(e)}`))
  }

  return dispose
}
