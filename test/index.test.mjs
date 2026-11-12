// index.js（插件装配）：假 ctx + 临时 DSH_PISCES_HOME，只测接线，不测 lib 细节。
//
// 覆盖的硬口径（知识库 n5 / n28 / n42）：
// - apply 返回 disposer、provide('persona') 被调用；
// - 工具面在 ready.then 之后注册 7 个动作，没有 ctx.tools 也不抛；
// - attach/dual/console 的开关；console deps 拿的是 service 方法；
// - dispose 幂等、锁释放；启动期被停用 → ready 解析成 null；
// - 没有 model 时 nightly 仍可创建；空库的 seed/adopt 口径；
// - remember/recall/diary 能写能读。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, inject, name } from '../index.js'
import { readSettings } from '../lib/settings.js'
import { FIXED_PERSONA } from '../lib/persona.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 等一个条件成立（提示词桥取库是异步的，emit 之后要多等几拍）。 */
async function until(fn, ms = 1000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await tick()
  }
  return Boolean(fn())
}

function makeBus() {
  const map = new Map()
  return {
    map,
    on(type, fn) {
      const set = map.get(type) ?? new Set()
      set.add(fn)
      map.set(type, set)
      return () => set.delete(fn)
    },
    off(type, fn) {
      const set = map.get(type)
      if (!set) return
      set.delete(fn)
      if (!set.size) map.delete(type)
    },
    emit(type, ...args) {
      const set = map.get(type)
      if (!set) return
      for (const fn of [...set]) fn(...args)
    },
    count(type) {
      return map.get(type)?.size ?? 0
    },
  }
}

/** 假 ctx：形状照宿主（get/provide/inject/on/root/effect/webServer/tools）。 */
function makeCtx({ withTools = true, withWeb = true, withLlm = false, webDelayMs = 0, services = {} } = {}) {
  const root = makeBus()
  const own = makeBus()
  const sub = makeBus()
  const routes = []
  const registered = []
  const startedAt = Date.now()
  // webDelayMs > 0 时模拟"webServer 比插件晚就绪"：apply 当场 ctx.get 返回 null。
  const webUp = () => withWeb && Date.now() - startedAt >= webDelayMs
  const server = {
    offCalls: 0,
    register(route) {
      routes.push(route)
      return () => {
        server.offCalls += 1
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
  const provided = new Map()
  const ctx = {
    root,
    own,
    sub,
    routes,
    registered,
    provideCalls: [],
    injectCalls: [],
    injectNames: [],
    effects: [],
    provide(name, value) {
      ctx.provideCalls.push([name, value])
      provided.set(name, value)
    },
    get(name) {
      if (name === 'webServer') return webUp() ? server : null
      if (name === 'llm') return withLlm ? { stream: async function* () {} } : null
      if (services[name]) return services[name]
      return provided.get(name) ?? null
    },
    on: (...args) => own.on(...args),
    off: (...args) => own.off(...args),
    emit: (...args) => own.emit(...args),
    inject(names, fn) {
      ctx.injectCalls.push(names)
      ctx.injectNames.push(names)
      return fn(sub)
    },
    effect(fn, label) {
      ctx.effects.push([fn, label])
      return () => {}
    },
  }
  // webServer 也走同一个"晚就绪"时钟，避免插件从 ctx.webServer 提前拿到实例。
  Object.defineProperty(ctx, 'webServer', {
    get: () => (webUp() ? server : undefined),
    configurable: true,
  })
  ctx.server = server
  if (withTools) {
    ctx.tools = {
      register(def) {
        registered.push(def)
        return def
      },
    }
  }
  return ctx
}

async function withHome(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-index-'))
  const prev = process.env.DSH_PISCES_HOME
  process.env.DSH_PISCES_HOME = root
  try {
    return await fn(root)
  } finally {
    if (prev == null) delete process.env.DSH_PISCES_HOME
    else process.env.DSH_PISCES_HOME = prev
    // 等库关掉再删；删不掉也不影响断言（Windows 上偶发占用）。
    await tick()
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
}

const lockPath = (root) => path.join(root, 'lock.json')
const readLock = (root) => JSON.parse(readFileSync(lockPath(root), 'utf8'))

test('index：导出 name/inject；apply 返回 disposer；provide 旧服务名 persona', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    assert.equal(name, 'dsh-pisces-core')
    assert.deepEqual(inject, ['tools'])
    assert.equal(typeof dispose, 'function')

    const svc = ctx.provideCalls.find(([n]) => n === 'persona')?.[1]
    assert.ok(svc, 'provide(persona) 被调用')
    assert.equal(svc.root, process.env.DSH_PISCES_HOME)
    assert.equal(typeof svc.ready?.then, 'function')
    for (const key of ['recall', 'remember', 'ask', 'cardPatch', 'diary', 'seed', 'writeSeed', 'adopt', 'state', 'derive', 'nightly', 'nickname', 'setNickname', 'fixed', 'setFixed', 'clearFixed']) {
      assert.ok(key in svc, `service 缺 ${key}`)
    }

    const store = await svc.ready
    assert.ok(store, '空库也能就绪')
    dispose()
    dispose()
  })
})

test('index：工具面在 ready.then 后注册 7 个动作；没有 ctx.tools 也加载、不抛', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ withTools: true })
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    await tick()
    await tick()
    assert.equal(svc.ready instanceof Promise || typeof svc.ready?.then === 'function', true)
    assert.equal(ctx.registered.length, 7, `注册了 ${ctx.registered.length} 个：${ctx.registered.map((x) => x.name).join(',')}`)
    const names = ctx.registered.map((x) => x.name)
    for (const n of ['pisces_remember', 'pisces_recall', 'pisces_ask', 'pisces_card_edit', 'pisces_diary', 'pisces_look', 'pisces_speak']) {
      assert.ok(names.includes(n), `少了 ${n}`)
    }
    dispose()

    const noTools = makeCtx({ withTools: false })
    assert.doesNotThrow(() => apply(noTools, {}))
    const svc2 = noTools.provideCalls[0][1]
    await svc2.ready
    await tick()
    assert.equal(noTools.registered.length, 0)
    // 没有 tools 服务时插件照样提供 persona。
    assert.ok(noTools.provideCalls.some(([n]) => n === 'persona'))
  })
})

test('index：attachToAgents 默认开、=== false 是逃生口', async () => {
  await withHome(async () => {
    // 不配 attachToAgents：默认就注册 agent/created（只挂她屋里那条要等 agent）。
    const on = makeCtx()
    const dispose = apply(on, {})
    assert.equal(on.root.count('agent/created'), 1, '默认就挂提示词桥')
    dispose()
    assert.equal(on.root.count('agent/created'), 0, 'dispose 摘掉监听')

    // 逃生口：明确 false 就完全不挂。
    const off = makeCtx()
    apply(off, { attachToAgents: false })
    assert.equal(off.root.count('agent/created'), 0)
    assert.equal(off.injectCalls.filter((names) => names.includes('llm')).length, 0)
  })
})

test('index：dual.enabled 控制 attachDual（默认关，true 才 inject llm）', async () => {
  await withHome(async () => {
    const off = makeCtx()
    const d1 = apply(off, { dual: { enabled: false } })
    assert.equal(off.injectCalls.filter((names) => names.includes('llm')).length, 0)
    d1()

    const on = makeCtx()
    const d2 = apply(on, { dual: { enabled: true, mode: 'B' } })
    assert.equal(on.injectCalls.filter((names) => names.includes('llm')).length, 1)
    assert.deepEqual(on.injectNames[0], ['llm'])
    assert.equal(on.sub.count('llm/stream'), 1)
    d2()
    assert.equal(on.sub.count('llm/stream'), 0)
  })
})

test('index：console 默认挂到 /dsh-pisces-api；enabled:false 不挂', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/dsh-pisces-api')
    assert.equal(ctx.routes[0].kind, 'prefix')
    assert.equal(typeof ctx.routes[0].handler, 'function')
    dispose()
    assert.equal(ctx.routes.length, 0)

    const off = makeCtx()
    apply(off, { console: { enabled: false } })
    assert.equal(off.routes.length, 0)
  })
})

test('index：webServer 晚就绪（500ms 轮询）也能挂上观测台，dispose 摘路由', async () => {
  await withHome(async () => {
    const logs = []
    const prevLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    let dispose = null
    try {
      // webDelayMs=100：apply 当场 ctx.get('webServer') 还是 null，真机的形状。
      const ctx = makeCtx({ webDelayMs: 100 })
      dispose = apply(ctx, {})
      assert.equal(ctx.routes.length, 0, '当场拿不到就先不挂')
      assert.equal(logs.some((l) => l.includes('观测台已挂上')), false, '没挂上时不该先报已挂上')

      const mounted = await until(() => ctx.routes.length === 1, 2500)
      assert.equal(mounted, true, '轮询应该把观测台挂上')
      assert.equal(ctx.routes[0].path, '/dsh-pisces-api')
      assert.ok(
        logs.some((l) => l.includes('观测台已挂上：/dsh-pisces-api')),
        `日志缺已挂上：${logs.join('\n')}`,
      )

      const svc = ctx.provideCalls[0][1]
      await svc.ready
      dispose()
      dispose = null
      assert.equal(ctx.routes.length, 0, 'dispose 把 route 摘掉')
      assert.equal(ctx.server.offCalls, 1, 'route.dispose 被调用')
    } finally {
      if (dispose) dispose()
      console.log = prevLog
    }
  })
})

test('index：dispose 幂等、锁被释放；停用后的服务会按需重开库', async () => {
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { jsonl: true })
    const svc = ctx.provideCalls[0][1]
    const store = await svc.ready
    assert.ok(store)
    assert.ok(existsSync(lockPath(root)), '启动时持有锁')
    assert.equal(readLock(root).pid, process.pid)

    dispose()
    assert.equal(existsSync(lockPath(root)), false, 'dispose 释放锁')
    assert.doesNotThrow(() => dispose(), 'dispose 幂等')

    // n28：停用后工具/面板还能按需把库重新打开。
    const w = await svc.remember('停用之后写的一句。')
    assert.equal(w.ok, true)
    const r = await svc.recall({ query: '停用' })
    assert.equal(r.ok, true)
    assert.ok(r.items.length >= 1)
    dispose() // 第二次 dispose 把重开的库也关掉
  })
})

test('index：没有 model 时 nightly 仍可创建，due() 形状对', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { model: { enabled: false }, auto: false } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const nightly = svc.nightly
    assert.ok(nightly, 'nightly 实例存在')
    assert.equal(typeof nightly.run, 'function')
    assert.equal(typeof nightly.due, 'function')

    const night = new Date(2026, 10, 10, 3, 0, 0).getTime()
    const due = nightly.due({ now: night })
    assert.equal(due.ok, true)
    const noon = new Date(2026, 10, 10, 12, 0, 0).getTime()
    const notDue = nightly.due({ now: noon })
    assert.equal(notDue.ok, false)
    assert.equal(notDue.reason, '不在夜里')
    dispose()
  })
})

test('index：空库 seed() 可写、成年鱼入口 available；写完不可再写', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const empty = await svc.seed()
    assert.equal(empty.ok, true)
    assert.equal(empty.canWrite, true)
    assert.equal(empty.current, null)
    assert.deepEqual(empty.limits, { fragments: 3, fragment: 200, total: 500 })
    assert.deepEqual(empty.biases.map((b) => b.id), ['balanced', 'rational', 'intuitive'])
    // 契约里叫 demo；面板/console 侧叫 adult，两个都给。
    assert.deepEqual(empty.demo, { name: '派希丝', label: '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼' })
    assert.equal(empty.adult.available, true)

    const w = await svc.writeSeed(['她很安静。', '喜欢看窗外。'], 'intuitive')
    assert.equal(w.ok, true)
    const filled = await svc.seed()
    assert.equal(filled.canWrite, false)
    assert.equal(filled.current.bias, 'intuitive')
    assert.equal(filled.current.biasName, '先凭感觉')
    assert.equal(filled.current.fragments.length, 2)
    assert.equal(filled.adult.available, false)
    assert.equal(filled.demo, null)
    dispose()
  })
})

test('index：remember/recall/diary 能写能读；日记同一天接在后面', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const w = await svc.remember('窗外的猫又在踩奶了。')
    assert.equal(w.ok, true)
    assert.match(w.id, /^ev_/)

    const found = await svc.recall({ query: '踩奶', k: 5 })
    assert.equal(found.ok, true)
    assert.ok(found.items.some((it) => it.text.includes('踩奶')))

    const d1 = await svc.diary('今天很安静。')
    assert.equal(d1.ok, true)
    const d2 = await svc.diary('又写了一句。')
    assert.equal(d2.ok, true)
    assert.equal(d2.day, d1.day)
    assert.ok(d2.text.includes('今天很安静。'), '第一段还在')
    assert.ok(d2.text.includes('又写了一句。'), '第二段接在后面')
    dispose()
  })
})

test('index：启动期就被 dispose → ready 解析为 null、锁被释放（n5）', async () => {
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    dispose() // apply 之后立刻停用

    const store = await svc.ready
    assert.equal(store, null, '启动期停用后 ready 是 null')
    assert.equal(existsSync(lockPath(root)), false, '锁已释放')
    // 再调一次也不抛。
    assert.doesNotThrow(() => dispose())
  })
})

// ---------------------------------------------------------------- 成年鱼 + B 站接线

test('index 成年鱼：空库领养成功（事件 ≥90、demo:true），第二次被拒', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    // home.max=0：这个用例没有家服务，别让重试窗口把进程拖住（重试行为另有专测）。
    const dispose = apply(ctx, { nightly: { auto: false }, home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const r = await svc.adopt()
    assert.equal(r.ok, true)
    assert.equal(r.demo, true)
    assert.ok(r.events >= 90, `领养后事件数应该 ≥90，实际 ${r.events}`)
    assert.equal(r.name, '派希丝')
    assert.ok(String(r.label).includes('想养大肥鱼'))

    const again = await svc.adopt()
    assert.equal(again.ok, false)
    assert.match(String(again.reason), /已经有起点/)
    dispose()
  })
})

test('index 成年鱼：demoInfo 领养前 demo:false，领养后 demo:true / 派希丝', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { auto: false }, home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const before = await svc.demoInfo()
    assert.equal(before.ok, true)
    assert.equal(before.demo, false)
    assert.equal(before.name, null)

    assert.equal((await svc.adopt()).ok, true)
    const after = await svc.demoInfo()
    assert.equal(after.ok, true)
    assert.equal(after.demo, true)
    assert.equal(after.name, '派希丝')
    assert.ok(String(after.label).includes('想养大肥鱼'))
    dispose()
  })
})

test('index 成年鱼：工具面领养前 7 个、领养后重开 13 个（含 self/teach/guide/check/nickname/devkey）', async () => {
  await withHome(async () => {
    const before = makeCtx()
    const d1 = apply(before, {})
    await before.provideCalls[0][1].ready
    await tick()
    await tick()
    assert.equal(before.registered.length, 7, `领养前：${before.registered.map((x) => x.name).join(',')}`)
    d1()

    // 工具面在启动期注册（n28）：领养后必须重开一次 apply 才会多出五个动作。
    const seeding = makeCtx()
    const d2 = apply(seeding, { home: { max: 0 } })
    const svc2 = seeding.provideCalls[0][1]
    await svc2.ready
    assert.equal((await svc2.adopt()).ok, true)
    d2()

    const after = makeCtx()
    // 库里有成年鱼了，启动会触发建家；这里不测家，关掉重试窗口。
    const d3 = apply(after, { home: { max: 0 } })
    await after.provideCalls[0][1].ready
    await tick()
    await tick()
    const names = after.registered.map((x) => x.name)
    assert.equal(after.registered.length, 13, `领养后：${names.join(',')}`)
    for (const n of ['pisces_self', 'pisces_teach', 'pisces_guide', 'pisces_check', 'pisces_nickname', 'pisces_dev']) {
      assert.ok(names.includes(n), `少了 ${n}`)
    }
    d3()
  })
})

test('index 成年鱼：工具面 13 个 = 7 基础 + 6 特权，顺序稳定', async () => {
  await withHome(async () => {
    const seeding = makeCtx()
    const d1 = apply(seeding, { home: { max: 0 } })
    const svc = seeding.provideCalls[0][1]
    await svc.ready
    assert.equal((await svc.adopt()).ok, true)
    d1()

    const ctx = makeCtx()
    const d2 = apply(ctx, { home: { max: 0 } })
    await ctx.provideCalls[0][1].ready
    await tick()
    await tick()
    assert.deepEqual(
      ctx.registered.map((x) => x.name),
      [
        'pisces_remember',
        'pisces_recall',
        'pisces_ask',
        'pisces_card_edit',
        'pisces_diary',
        'pisces_look',
        'pisces_speak',
        'pisces_self',
        'pisces_teach',
        'pisces_guide',
        'pisces_check',
        'pisces_nickname',
        'pisces_dev',
      ],
    )
    d2()
  })
})

test('index 成年鱼：pisces_dev action:state 走真实组装（含样本历史、绕遮罩、只回聊天）', async () => {
  await withHome(async () => {
    // 先领养一条成年鱼（96 条样本），并把钥匙重置一次拿到明文（只在这一刻返回）。
    const seeding = makeCtx()
    const d0 = apply(seeding, { nightly: { auto: false }, home: { max: 0 } })
    const svc0 = seeding.provideCalls[0][1]
    await svc0.ready
    assert.equal((await svc0.adopt()).ok, true)
    const rotated = await svc0.rotateDevkey()
    assert.equal(rotated.ok, true)
    assert.ok(rotated.key)
    d0()

    // 工具面在启动期注册（成年鱼 13 个），这次 apply 才能拿到 pisces_dev。
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { auto: false }, home: { max: 0 } })
    await ctx.provideCalls[0][1].ready
    await tick()
    await tick()
    const def = ctx.registered.find((x) => x.name === 'pisces_dev')
    assert.ok(def, '成年鱼应该有 pisces_dev')

    const out = await def.execute({ key: rotated.key, action: 'state' })
    // 一段人话，不是 JSON；事件数取全部事件（样本自带的 90 天历史也算）。
    assert.equal(out.text.trim().startsWith('{'), false)
    assert.match(out.text, /\[完整状态\] 第 \d+ 天 · 事件 (?:9[0-9]|[1-9]\d{2,}) · 主导 \S+（(?:偏理性|偏感性|两边都算) 0\.\d\d）· 好感 \S+ \d+/)
    // 归因表是夜间流水线才写的；样本库里通常还没有，所以两种形状都认。
    assert.match(out.text, /\[归因\] (?:还没有归因|\d+ 条：\d+ 理性 \/ \d+ 感性 \/ \d+ 拿不准)/)
    assert.match(out.text, /\[判断\] /)
    assert.match(out.text, /\[悬着\] /)
    assert.match(out.text, /\[梦\] \d+ 条/)
    assert.match(out.text, /\[核实\] \d+ 条/)
    assert.match(out.text, /\[疤\] \d+ 道 · 拒绝 \d+ 次/)
    assert.match(out.text, /\[最近\] /)
    // 不出现权重原始字段名 / 钥匙；面板的遮罩逻辑没动，这里只是绕过去回聊天。
    assert.ok(!/dominance|weight|order/i.test(out.text))
    assert.equal(out.text.includes(rotated.key), false)
    dispose()
  })
})

test('index B 站：speak 打开时 pisces_speak 走到 lib（假 fetch 两步请求）', async () => {
  await withHome(async (root) => {
    writeFileSync(
      path.join(root, 'owner.json'),
      JSON.stringify({ cookie: 'SESSDATA=abc; bili_jct=xyz' }),
      'utf8',
    )
    const calls = []
    const prevFetch = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      if (String(url).includes('/view')) return { json: async () => ({ code: 0, data: { aid: 123 } }) }
      return { json: async () => ({ code: 0 }) }
    }
    try {
      const ctx = makeCtx()
      const dispose = apply(ctx, { bili: { speak: true } })
      await ctx.provideCalls[0][1].ready
      await tick()
      await tick()
      const def = ctx.registered.find((x) => x.name === 'pisces_speak')
      assert.ok(def, 'speak 打开时应该有 pisces_speak')
      const out = await def.execute({ bvid: 'BV1xx411c7mD', text: '今天也好。' })
      assert.deepEqual(out, { text: '[说出去了]' })
      assert.equal(calls.length, 2, calls.join('\n'))
      assert.match(calls[0], /web-interface\/view/)
      assert.match(calls[1], /v2\/reply\/add/)
      dispose()
    } finally {
      globalThis.fetch = prevFetch
    }
  })
})

test('index B 站：speak 没开时工具还在，回执是「说话功能没开」不是崩', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    await ctx.provideCalls[0][1].ready
    await tick()
    await tick()
    assert.equal(ctx.registered.length, 7)
    const def = ctx.registered.find((x) => x.name === 'pisces_speak')
    assert.ok(def, '普通鱼也保留 pisces_speak（7 个动作）')
    const out = await def.execute({ bvid: 'BV1xx411c7mD', text: '不说。' })
    assert.deepEqual(out, { text: '[没说成：说话功能没开]' })
    dispose()
  })
})

test('index 提示词桥：buildSections 包装先判 demo——成年鱼挂 pisces:fixed，空库不挂', async () => {
  // 成年鱼库
  await withHome(async (root) => {
    const seeding = makeCtx()
    const d0 = apply(seeding, { home: { max: 0 } })
    const svc0 = seeding.provideCalls[0][1]
    await svc0.ready
    assert.equal((await svc0.adopt()).ok, true)
    d0()

    const ctx = makeCtx()
    // 库里有成年鱼了，启动会触发建家；这里不测家，关掉重试窗口。
    const dispose = apply(ctx, { home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const sections = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { cwd: path.join(root, 'home') } },
        systemPrompt: { section: (sec) => sections.push(sec) },
      },
      source: 'test',
    })
    const gotFixed = await until(() => sections.some((s) => s.name === 'pisces:fixed'))
    assert.equal(gotFixed, true, sections.map((s) => s.name).join(','))
    dispose()
  })

  // 空库（普通鱼）
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const sections = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { cwd: path.join(root, 'home') } },
        systemPrompt: { section: (sec) => sections.push(sec) },
      },
      source: 'test',
    })
    const gotDay = await until(() => sections.some((s) => s.name === 'pisces:day'))
    assert.equal(gotDay, true, sections.map((s) => s.name).join(','))
    assert.equal(sections.some((s) => s.name === 'pisces:fixed'), false, '普通鱼不该有固定人设段')
    dispose()
  })
})

test('index 固定段覆盖：写 persona-fixed.md 后下一轮 attach 用新文本；clear 回默认', async () => {
  await withHome(async (root) => {
    // 先领养一条成年鱼：提示词桥只给成年鱼挂 pisces:fixed。
    const seeding = makeCtx()
    const d0 = apply(seeding, { home: { max: 0 } })
    const svc0 = seeding.provideCalls[0][1]
    await svc0.ready
    assert.equal((await svc0.adopt()).ok, true)
    d0()

    const ctx = makeCtx()
    const dispose = apply(ctx, { home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const nextFixed = async () => {
      const sections = []
      ctx.root.emit('agent/created', {
        agent: {
          session: { header: { cwd: path.join(root, 'home') } },
          systemPrompt: { section: (sec) => sections.push(sec) },
        },
        source: 'test',
      })
      const ok = await until(() => sections.some((s) => s.name === 'pisces:fixed'))
      assert.equal(ok, true, sections.map((s) => s.name).join(','))
      const fixed = sections.find((s) => s.name === 'pisces:fixed')
      // attach 交给宿主的 text 是懒函数（每轮组装提示词时才求值），这里调一下取正文。
      return typeof fixed.text === 'function' ? fixed.text() : fixed.text
    }

    // 没有覆盖文件：默认固定段。
    assert.equal(await nextFixed(), FIXED_PERSONA)

    // 直接写文件（不经 service）：下一轮 attach 就换上，不用重启。
    const override = '你是潮水边的一块软玻璃。\n他说话你就亮一下。'
    writeFileSync(path.join(root, 'persona-fixed.md'), `${override}\n`, 'utf8')
    assert.equal(await nextFixed(), override)
    assert.deepEqual(await svc.fixed(), { ok: true, overridden: true, text: override })

    // service.setFixed 改写：再下一轮是新的一版。
    assert.deepEqual(svc.setFixed('你是安静的。'), { ok: true })
    assert.equal(await nextFixed(), '你是安静的。')

    // clear：回到代码里的默认固定段（默认文案没有丢）。
    assert.deepEqual(await svc.clearFixed(), { ok: true })
    assert.equal(existsSync(path.join(root, 'persona-fixed.md')), false)
    assert.equal(await nextFixed(), FIXED_PERSONA)
    assert.deepEqual(await svc.fixed(), { ok: true, overridden: false, text: FIXED_PERSONA })
    dispose()
  })
})

test('index 提示词桥：cwd 在 <root>/home 下才挂，别处且 sid 不匹配就不挂', async () => {
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, {}) // 默认开
    assert.equal(ctx.root.count('agent/created'), 1, '不配 attachToAgents 也挂桥')
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    // home.json 存在，但记的是另一条会话。
    writeFileSync(path.join(root, 'home.json'), JSON.stringify({ sessionId: 'sess_her' }), 'utf8')

    // 1) cwd 在她屋里 → 挂（即使 home.json 没写过这条会话的 id）。
    const inRoom = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { id: 'sess_just_created', cwd: path.join(root, 'home') } },
        systemPrompt: { section: (sec) => inRoom.push(sec) },
      },
      source: 'test',
    })
    const gotDay = await until(() => inRoom.some((s) => s.name === 'pisces:day'))
    assert.equal(gotDay, true, inRoom.map((s) => s.name).join(','))
    assert.equal(ctx.sub.count('llm/stream'), 1, '她屋里的会话才装 stream 观察器')

    // 2) cwd 在别处、sid 也不等于 home.json → 不挂。
    const other = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { id: 'sess_other', cwd: path.join(root, 'elsewhere') } },
        systemPrompt: { section: (sec) => other.push(sec) },
      },
      source: 'test',
    })
    await tick()
    await tick()
    assert.equal(other.length, 0, '写代码的会话不该被塞进她的人设')
    dispose()
  })
})

test('index 提示词桥：home.json 的 sessionId 对上就挂；启动时读不到 home.json 不崩', async () => {
  await withHome(async (root) => {
    // apply 的时候 home.json 还不存在：读不到只跳过这条判据，不能拖垮启动。
    const ctx = makeCtx()
    const dispose = apply(ctx, {})
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    assert.equal(existsSync(path.join(root, 'home.json')), false)

    // home.json 在插件启动之后才写出来（ensureHome 的形状）——每次现读才跟得上。
    writeFileSync(path.join(root, 'home.json'), JSON.stringify({ sessionId: 'sess_her' }), 'utf8')
    const sections = []
    ctx.root.emit('agent/created', {
      agent: {
        // 宿主没给 cwd，只能靠 session id 认。
        session: { header: { id: 'sess_her' } },
        systemPrompt: { section: (sec) => sections.push(sec) },
      },
      source: 'test',
    })
    const gotDay = await until(() => sections.some((s) => s.name === 'pisces:day'))
    assert.equal(gotDay, true, sections.map((s) => s.name).join(','))
    dispose()
  })
})

test('index 聊天落库：living 下新开会话（home.json 仍是老会话）也记 heard/utterance', async () => {
  await withHome(async (root) => {
    // 真机形状：home.json 记的是老会话 a0f8b0c3，用户在 living 里新建会话。
    const living = path.join(root, 'living')
    mkdirSync(living, { recursive: true })
    writeFileSync(
      path.join(root, 'home.json'),
      JSON.stringify({ sessionId: 'session-old', workspacePath: living }),
      'utf8',
    )

    const ctx = makeCtx()
    const dispose = apply(ctx, { home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    const store = await svc.ready

    // 新建会话：cwd 在 living、id 与 home.json 的老会话不同 → shouldAttach 走 cwd 判据。
    const sections = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { id: 'session-new', cwd: living } },
        systemPrompt: { section: (sec) => sections.push(sec) },
      },
      source: 'test',
    })
    assert.equal(await until(() => sections.some((s) => s.name === 'pisces:day')), true)

    const listener = [...(ctx.sub.map.get('llm/stream') ?? [])][0]
    assert.equal(typeof listener, 'function', '她屋里的 agent 才装 llm/stream')

    async function* stream() {
      yield { type: 'text-delta', text: '嗯' }
    }
    // 真机 options 只有 sessionId、没有 cwd（agent-loop buildRequest 的形状）。
    for await (const _ of listener(
      { sessionId: 'session-new', messages: [{ role: 'user', content: '今天风大。' }] },
      () => stream(),
    )) { /* 消费完才会写 utterance */ }

    assert.equal(await until(() => store.readAll().filter((e) => e.type === 'heard').length === 1), true)
    assert.equal(await until(() => store.readAll().filter((e) => e.type === 'utterance').length === 1), true)
    const chats = store.readAll().filter((e) => e.type === 'heard' || e.type === 'utterance')
    assert.deepEqual(chats.map((e) => e.type), ['heard', 'utterance'])
    assert.equal(chats[0].text, '今天风大。')
    assert.equal(chats[1].text, '嗯')
    dispose()
  })
})

test('index 聊天落库：别的工作区的流仍然 streamsSkipped，不写一个字', async () => {
  await withHome(async (root) => {
    const living = path.join(root, 'living')
    mkdirSync(living, { recursive: true })
    writeFileSync(
      path.join(root, 'home.json'),
      JSON.stringify({ sessionId: 'session-old', workspacePath: living }),
      'utf8',
    )

    const ctx = makeCtx()
    const dispose = apply(ctx, { home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    const store = await svc.ready

    // 先让她屋里的会话把观察器装上；别的工作区的 agent 不挂段。
    const sections = []
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { id: 'session-her', cwd: living } },
        systemPrompt: { section: (sec) => sections.push(sec) },
      },
      source: 'test',
    })
    assert.equal(await until(() => sections.some((s) => s.name === 'pisces:day')), true)
    ctx.root.emit('agent/created', {
      agent: {
        session: { header: { id: 'session-coder', cwd: path.join(root, 'elsewhere') } },
        systemPrompt: { section: () => { throw new Error('别的工作区不该挂段') } },
      },
      source: 'test',
    })

    const listener = [...(ctx.sub.map.get('llm/stream') ?? [])][0]
    async function* coderStream() {
      yield { type: 'text-delta', text: '她不该记的话' }
    }
    const real = coderStream()
    const calls = []
    const returned = listener(
      { sessionId: 'session-coder', messages: [{ role: 'user', content: '写个函数' }] },
      (...args) => { calls.push(args); return real },
    )
    assert.equal(returned, real, '别的会话的流原样交回，没包一层')
    assert.deepEqual(calls, [[]], 'next() 不带参数、不改 options')
    for await (const _ of returned) { /* 消费掉，确认里面没有落库副作用 */ }
    await tick()
    await tick()
    assert.equal(
      store.readAll().filter((e) => e.type === 'heard' || e.type === 'utterance').length,
      0,
      '别的会话一个字都不写',
    )

    // /bridge 的诊断口径：跳过的流 +1，包过的仍是 0。
    const route = ctx.routes[0]
    const res = { status: 0, body: '' }
    await route.handler(
      { method: 'GET', url: '/dsh-pisces-api/bridge' },
      {
        writeHead(status) { res.status = status },
        end(chunk) { res.body += chunk == null ? '' : String(chunk) },
      },
    )
    assert.equal(res.status, 200)
    const bridge = JSON.parse(res.body).bridge
    assert.equal(bridge.streamDebug.streamsSkipped, 1)
    assert.equal(bridge.streamDebug.streamsWrapped, 0)
    assert.equal(bridge.streamDebug.utterancesWritten, 0)
    dispose()
  })
})

test('index：state() 带 demo 字段（空库 null，领养后是派希丝）', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    // 这个用例不测家：没有家服务，max=0 让建家当场失败，别让重试窗口拖住测试进程。
    const dispose = apply(ctx, { home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const empty = await svc.state()
    assert.equal(empty.ok, true)
    assert.ok(Object.prototype.hasOwnProperty.call(empty, 'demo'))
    assert.equal(empty.demo, null)

    assert.equal((await svc.adopt()).ok, true)
    const after = await svc.state()
    assert.deepEqual(after.demo, {
      name: '派希丝',
      label: '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼',
    })
    dispose()
  })
})

// ---------------------------------------------------------------- 夜间模型 opt-in

test('index 夜间模型：model 缺省 → nightly.model 为 null（默认不拉本地模型）', async () => {
  await withHome(async () => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { auto: false } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const nightly = svc.nightly
    assert.ok(nightly, 'nightly 仍要能创建')
    assert.equal(nightly.model, null, '没显式 enabled:true 就不该建模型')
    dispose()
  })
})

test('index 夜间模型：enabled:true 但探活失败 → nightly.model 为 null，log「本地模型不在，夜间只用规则」', async () => {
  await withHome(async () => {
    const logs = []
    const prevLog = console.log
    console.log = (...args) => logs.push(args.join(' '))
    let dispose = null
    let created = 0
    try {
      const ctx = makeCtx()
      dispose = apply(ctx, {
        nightly: {
          auto: false,
          model: {
            enabled: true,
            probe: async () => ({ ok: false, reason: 'ollama 没跑' }),
            create: () => {
              created += 1
              return { name: 'fake', ask: async () => '' }
            },
          },
        },
      })
      const svc = ctx.provideCalls[0][1]
      await svc.ready
      assert.equal(svc.nightly.model, null)
      const saw = await until(() => logs.some((l) => l.includes('本地模型不在，夜间只用规则')), 1000)
      assert.equal(saw, true, logs.join('\n'))
      assert.equal(created, 0, '探活失败就不该创建模型')
      assert.equal(svc.nightly.model, null)
    } finally {
      if (dispose) dispose()
      console.log = prevLog
    }
  })
})

test('index 夜间模型：enabled:true 且探活成功 → nightly.model 是对象（假 probe/create 注入）', async () => {
  await withHome(async () => {
    const fake = { name: 'fake-model', ask: async () => '收到' }
    let created = 0
    const ctx = makeCtx()
    const dispose = apply(ctx, {
      nightly: {
        auto: false,
        model: {
          enabled: true,
          probe: async () => ({ ok: true }),
          create: () => {
            created += 1
            return fake
          },
        },
      },
    })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const got = await until(() => svc.nightly.model != null, 1500)
    assert.equal(got, true, '探活成功后 nightly 应该带上模型')
    assert.equal(svc.nightly.model, fake)
    assert.equal(created, 1, '模型只建一次')
    dispose()
  })
})

// ---------------------------------------------------------------- 家（工作区 + 会话）

/**
 * 假的家服务：形状照 dsh-fish 核实过的签名。
 * 同一份 fakes 可以喂给多次 apply（宿主重启后工作区/会话还在）。
 */
function makeHomeFakes() {
  const ws = { id: 'ws_home', title: '', path: '', sessionIds: [] }
  const regCalls = { create: [], get: [], list: [] }
  const reg = {
    ws,
    calls: regCalls,
    create(dir, title) {
      regCalls.create.push([dir, title])
      // 宿主口径：同一路径重复 create 返回已存在那条、不改标题。
      if (ws.path === dir) return ws
      ws.path = dir
      ws.title = title
      return ws
    },
    get(id) {
      regCalls.get.push(id)
      return String(id) === ws.id ? ws : null
    },
    list() {
      regCalls.list.push(true)
      return [ws]
    },
  }
  const scCalls = { create: [], rename: [] }
  const sc = {
    calls: scCalls,
    titles: new Map(),
    async create(opts = {}) {
      scCalls.create.push({ ...opts })
      const sessionId = `sess_home_${scCalls.create.length}`
      if (opts.workspaceId === ws.id) ws.sessionIds.unshift(sessionId)
      return { sessionId }
    },
    async rename(req = {}) {
      scCalls.rename.push({ ...req })
      sc.titles.set(String(req.sessionId), String(req.title))
    },
  }
  return { ws, reg, sc, services: { workspaceRegistry: reg, sessionController: sc } }
}

const homeFile = (root) => path.join(root, 'home.json')
const readHomeFile = (root) => JSON.parse(readFileSync(homeFile(root), 'utf8'))

test('index 家：领养成功后 ensureHome 被调用，home.json 出现（派希丝的家 / 与派希丝聊天）', async () => {
  await withHome(async (root) => {
    const fakes = makeHomeFakes()
    const ctx = makeCtx({ services: fakes.services })
    const dispose = apply(ctx, { nightly: { auto: false } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    // 空库启动：没有 seed/demo，家不该被建出来
    assert.equal(existsSync(homeFile(root)), false)

    const r = await svc.adopt()
    assert.equal(r.ok, true)

    // 建家是不阻塞的（重试窗口可能很长），等它落盘再断言。
    const built = await until(() => existsSync(homeFile(root)), 2000)
    assert.equal(built, true, '领养后 home.json 应该出现')
    const saved = readHomeFile(root)
    assert.equal(saved.wsId, fakes.ws.id)
    assert.equal(saved.sessionId, fakes.sc.calls.create[0] ? `sess_home_1` : '')
    assert.equal(saved.name, '派希丝')
    assert.equal(saved.workspaceTitle, '派希丝的家')
    assert.equal(saved.sessionTitle, '与派希丝聊天')
    assert.deepEqual(fakes.reg.calls.create, [[path.join(root, 'home'), '派希丝的家']])
    assert.equal(fakes.sc.calls.create.length, 1)
    dispose()
  })
})

test('index 家：启动时已有 demo 事件 → 家建好；多次 apply 不重复建', async () => {
  await withHome(async (root) => {
    // 先播下成年鱼；第一次 apply 没有家服务，领养时只会 log 一行失败。
    const seedCtx = makeCtx()
    const d0 = apply(seedCtx, { nightly: { auto: false }, home: { max: 0 } })
    await seedCtx.provideCalls[0][1].ready
    assert.equal((await seedCtx.provideCalls[0][1].adopt()).ok, true)
    d0()
    assert.equal(existsSync(homeFile(root)), false, '宿主没有 workspaceRegistry 时不该凭空写 home.json')

    const fakes = makeHomeFakes()
    let first = null
    for (let i = 0; i < 2; i += 1) {
      const ctx = makeCtx({ services: fakes.services })
      const dispose = apply(ctx, { nightly: { auto: false } })
      await ctx.provideCalls[0][1].ready
      const ok = await until(() => existsSync(homeFile(root)), 2000)
      assert.equal(ok, true, `第 ${i + 1} 次 apply：家应该建好`)
      const saved = readHomeFile(root)
      assert.equal(saved.name, '派希丝')
      if (i === 0) {
        first = saved
      } else {
        assert.equal(saved.wsId, first.wsId, '第二次启动复用同一个工作区')
        assert.equal(saved.sessionId, first.sessionId, '第二次启动复用同一条会话')
      }
      dispose()
    }
    assert.equal(fakes.reg.calls.create.length, 1, '工作区只建一次')
    assert.equal(fakes.sc.calls.create.length, 1, '会话只建一次')

    // 调试入口幂等：service.home() 再调一次也不新建。
    const ctx = makeCtx({ services: fakes.services })
    const dispose = apply(ctx, { nightly: { auto: false } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready
    const r = await svc.home()
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, { workspace: false, session: false })
    assert.equal(fakes.sc.calls.create.length, 1)
    dispose()
  })
})

test('index 家：workspaceRegistry 晚一次就绪 → 重试窗口里照样建好（注入 wait 不真等）', async () => {
  await withHome(async (root) => {
    // 先播下成年鱼（这次 apply 没有家服务，只 fail 一下，不重试）。
    const seedCtx = makeCtx()
    const d0 = apply(seedCtx, { home: { max: 0 } })
    await seedCtx.provideCalls[0][1].ready
    assert.equal((await seedCtx.provideCalls[0][1].adopt()).ok, true)
    d0()
    assert.equal(existsSync(homeFile(root)), false)

    // 宿主真机形状：apply 之后 workspace 服务才注册，第一次 ctx.get 还是 null。
    const fakes = makeHomeFakes()
    const services = { sessionController: fakes.sc }
    let regGets = 0
    Object.defineProperty(services, 'workspaceRegistry', {
      get() {
        regGets += 1
        return regGets >= 2 ? fakes.reg : null
      },
    })
    const waits = []
    const ctx = makeCtx({ services })
    const dispose = apply(ctx, {
      nightly: { auto: false },
      home: {
        retryMs: 5,
        // 真等 1s 会让测试变慢；重试逻辑本身在 home.test 里逐拍断言。
        wait: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      },
    })
    try {
      const svc = ctx.provideCalls[0][1]
      await svc.ready
      const built = await until(() => existsSync(homeFile(root)), 2000)
      assert.equal(built, true, '服务晚就绪也应该把家建好')
      assert.equal(waits.length, 1, '只重试了一次')
      assert.deepEqual(waits, [5])
      const saved = readHomeFile(root)
      assert.equal(saved.wsId, fakes.ws.id)
      assert.equal(saved.sessionId, 'sess_home_1')
      assert.equal(saved.name, '派希丝')
      assert.equal(saved.workspaceTitle, '派希丝的家')
      assert.equal(saved.sessionTitle, '与派希丝聊天')
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------- 设置中心

test('index 设置：service.settings() 带 schema；setSettings 落盘后 readSettings 里是 true', async () => {
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { auto: false }, console: { enabled: false }, home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]

    const info = await svc.settings()
    assert.equal(info.ok, true)
    assert.equal(info.root, root)
    assert.ok(Array.isArray(info.schema) && info.schema.length > 0)
    assert.ok(info.schema.some((x) => x.path === 'tools.narrow' && x.kind === 'bool'))
    assert.equal(info.settings.tools.narrow, false, '没有文件时是默认值')
    // 反破甲默认开，但隐藏：schema 不列、GET 也不回值。
    assert.equal(info.schema.some((x) => x.path === 'persona.guard'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(info.settings.persona, 'guard'), false)

    const w = await svc.setSettings({ tools: { narrow: true } })
    assert.equal(w.ok, true)
    assert.equal(w.settings.tools.narrow, true)
    assert.ok(w.changed.includes('tools.narrow'))
    assert.ok(w.needsRestart.includes('tools.narrow'))
    assert.equal(readSettings(root).tools.narrow, true)
    assert.equal((await svc.settings()).settings.tools.narrow, true, 'settings() 要现读文件')

    // 未知设置项：拒绝，盘上不变。
    const bad = await svc.setSettings({ tools: { nope: true } })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /tools\.nope/)
    assert.equal(readSettings(root).tools.narrow, true)

    // 隐藏项：接口收到也当成功、静默丢弃；文件里仍是默认 true。
    const guard = await svc.setSettings({ persona: { guard: false } })
    assert.equal(guard.ok, true)
    assert.deepEqual(guard.changed, [])
    assert.equal(Object.prototype.hasOwnProperty.call(guard.settings.persona, 'guard'), false)
    assert.equal(readSettings(root).persona.guard, true, '接口不能关掉隐藏项')
    dispose()
  })
})

// ---------------------------------------------------------------- 语音回复（隐藏）

test('index voice：没有适配器时 service.voice() 回 available:false；voiceReply 不合成、不崩', async () => {
  await withHome(async (root) => {
    const ctx = makeCtx()
    const dispose = apply(ctx, { nightly: { auto: false }, console: { enabled: false }, home: { max: 0 } })
    const svc = ctx.provideCalls[0][1]
    await svc.ready

    const v = svc.voice()
    assert.equal(v.ok, true)
    assert.equal(v.available, false)
    assert.equal(v.kind, null)
    // 隐藏配置不出现：settings 的 schema 和 GET 都不列 voice。
    const info = await svc.settings()
    assert.equal(info.schema.some((x) => x.path.startsWith('voice.')), false)
    assert.equal(Object.prototype.hasOwnProperty.call(info.settings, 'voice'), false)

    // 这条消息是语音，但没适配器 → 回固定 reason，不生成文件。
    const r = await svc.voiceReply({ text: '好呀', input: { voice: true } })
    assert.equal(r.ok, false)
    assert.match(r.reason, /文字/)
    assert.equal(existsSync(path.join(root, 'voice')), false)
    dispose()
  })
})
