// lib/home.js：她的家（工作区 + 会话）——只测「建一次、之后复用」这一层。
//
// 假服务照宿主签名：{ get:(n)=> n==='workspaceRegistry'? fakeReg : n==='sessionController'? fakeSc : null }
// 假 reg 记 create/get/list，假 sc 记 create/rename；两者共享同一个 ws 对象，
// 模拟宿主「create 返回已存在那条」「新会话挂进 ws.sessionIds」的行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  HOME_GRACE_MS,
  TITLE_SESSION,
  TITLE_WORKSPACE,
  ensureHome,
  ensureHomeWithRetry,
  homeTitles,
} from '../lib/home.js'

async function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-home-'))
  try {
    return await fn(root)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* Windows 上偶发占用，删不掉不影响断言 */
    }
  }
}

const homeFile = (root) => path.join(root, 'home.json')
const readHome = (root) => JSON.parse(readFileSync(homeFile(root), 'utf8'))

function makeFakes() {
  const ws = { id: 'ws_home', title: '', path: '', sessionIds: [], setTitleCalls: [] }
  const regCalls = { create: [], get: [], list: [] }
  const reg = {
    ws,
    calls: regCalls,
    create(dir, title) {
      regCalls.create.push([dir, title])
      // 宿主口径：同一路径重复 create 返回**已存在**那条，不改标题。
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
  // 改名走实体上的 setTitle（宿主真形状）；有它就不会走到「宿主不支持」那一行。
  ws.setTitle = async (title) => {
    ws.setTitleCalls.push(title)
    ws.title = title
  }

  const scCalls = { create: [], rename: [] }
  const sc = {
    calls: scCalls,
    titles: new Map(),
    create(opts = {}) {
      scCalls.create.push({ ...opts })
      const sessionId = `sess_home_${scCalls.create.length}`
      // 宿主会把会话挂进工作区（真机是异步索引；测试里先同步挂上，宽限期单独测）。
      if (opts.workspaceId === ws.id) ws.sessionIds.unshift(sessionId)
      return { sessionId }
    },
    rename(req = {}) {
      scCalls.rename.push({ ...req })
      sc.titles.set(String(req.sessionId), String(req.title))
    },
  }
  const ctx = {
    get: (n) => (n === 'workspaceRegistry' ? reg : n === 'sessionController' ? sc : null),
  }
  return { ws, reg, sc, ctx }
}

test('home：homeTitles 有名字/没名字两套标题', () => {
  assert.deepEqual(homeTitles('派希丝'), { workspace: '派希丝的家', session: '与派希丝聊天' })
  assert.deepEqual(homeTitles(null), { workspace: TITLE_WORKSPACE, session: TITLE_SESSION })
  assert.deepEqual(homeTitles('   '), { workspace: '肥鱼的家', session: '与肥鱼聊天' })
})

test('home：有名字 → 工作区「派希丝的家」、会话「与派希丝聊天」，home.json 写回', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    const r = await ensureHome({ ctx: f.ctx, root, name: '派希丝', log: () => {} })

    assert.equal(r.ok, true)
    assert.equal(r.workspaceTitle, '派希丝的家')
    assert.equal(r.sessionTitle, '与派希丝聊天')
    assert.deepEqual(r.created, { workspace: true, session: true })
    assert.equal(r.dir, path.join(root, 'home'))
    assert.equal(existsSync(path.join(root, 'home')), true, '家目录建出来')

    assert.deepEqual(f.reg.calls.create, [[path.join(root, 'home'), '派希丝的家']])
    assert.equal(f.sc.calls.create.length, 1)
    assert.equal(f.sc.calls.create[0].workspaceId, r.wsId)
    assert.deepEqual(f.sc.calls.rename, [{ sessionId: r.sessionId, title: '与派希丝聊天' }])

    const saved = readHome(root)
    assert.equal(saved.wsId, r.wsId)
    assert.equal(saved.sessionId, r.sessionId)
    assert.equal(saved.name, '派希丝')
    assert.ok(saved.at, 'at 落库')
    assert.equal(saved.workspaceTitle, '派希丝的家')
    assert.equal(saved.sessionTitle, '与派希丝聊天')
  })
})

test('home：没名字 → 「肥鱼的家」/「与肥鱼聊天」', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    const r = await ensureHome({ ctx: f.ctx, root })
    assert.equal(r.ok, true)
    assert.equal(r.workspaceTitle, '肥鱼的家')
    assert.equal(r.sessionTitle, '与肥鱼聊天')
    assert.deepEqual(f.reg.calls.create, [[path.join(root, 'home'), '肥鱼的家']])
    assert.deepEqual(f.sc.calls.rename, [{ sessionId: r.sessionId, title: '与肥鱼聊天' }])
    const saved = readHome(root)
    assert.equal(saved.name, null)
  })
})

test('home：第二次调用不新建（create 不再被调，id 不变）', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    const first = await ensureHome({ ctx: f.ctx, root, name: '派希丝' })
    const second = await ensureHome({ ctx: f.ctx, root, name: '派希丝' })

    assert.equal(second.ok, true)
    assert.equal(f.reg.calls.create.length, 1, '工作区不重复建')
    assert.equal(f.sc.calls.create.length, 1, '会话不重复建')
    assert.equal(second.wsId, first.wsId)
    assert.equal(second.sessionId, first.sessionId)
    assert.deepEqual(second.created, { workspace: false, session: false })
    assert.equal(f.sc.calls.rename.length, 1, '标题没变就不再改名')
    assert.equal(readHome(root).sessionId, first.sessionId)
  })
})

test('home：sessionIds 里没有旧会话且宽限期已过 → 重建会话并写回', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    const first = await ensureHome({ ctx: f.ctx, root, name: '派希丝' })
    assert.equal(f.sc.calls.create.length, 1)

    // 宿主那边会话被归档/删了：索引里查不到
    f.ws.sessionIds = []
    const later = Date.now() + HOME_GRACE_MS + 5_000
    const second = await ensureHome({ ctx: f.ctx, root, name: '派希丝', now: later })

    assert.equal(second.ok, true)
    assert.equal(f.reg.calls.create.length, 1, '工作区还在，不重建')
    assert.equal(f.sc.calls.create.length, 2, '会话重建一次')
    assert.notEqual(second.sessionId, first.sessionId)
    assert.deepEqual(second.created, { workspace: false, session: true })
    assert.equal(readHome(root).sessionId, second.sessionId)
    assert.equal(readHome(root).createdAt, new Date(later).toISOString())
  })
})

test('home：没有 workspaceRegistry → {ok:false, reason}，不抛、不建目录', async () => {
  await withRoot(async (root) => {
    const ctx = { get: () => null }
    const r = await ensureHome({ ctx, root, name: '派希丝' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, '宿主没有 workspaceRegistry 服务')
    assert.equal(existsSync(path.join(root, 'home')), false)
    assert.equal(existsSync(homeFile(root)), false)

    // 连 get 都没有（假 ctx 只给了空对象）也不抛
    const r2 = await ensureHome({ ctx: {}, root })
    assert.equal(r2.ok, false)
    assert.equal(r2.reason, '宿主没有 workspaceRegistry 服务')
  })
})

test('home：名字从空变成「派希丝」→ 会话 rename 一次、标题跟着变', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    const first = await ensureHome({ ctx: f.ctx, root })
    assert.equal(first.sessionTitle, '与肥鱼聊天')
    assert.equal(f.sc.calls.rename.length, 1)

    const second = await ensureHome({ ctx: f.ctx, root, name: '派希丝' })
    assert.equal(second.ok, true)
    assert.equal(second.wsId, first.wsId)
    assert.equal(second.sessionId, first.sessionId, '会话复用，不新建')
    assert.equal(f.sc.calls.create.length, 1)
    assert.equal(f.sc.calls.rename.length, 2, '换名字只多改名一次')
    assert.deepEqual(f.sc.calls.rename[1], { sessionId: first.sessionId, title: '与派希丝聊天' })
    assert.equal(f.sc.titles.get(first.sessionId), '与派希丝聊天')
    // 工作区标题宿主支持就改（setTitle），不支持只 log 一行
    assert.equal(f.ws.title, '派希丝的家')
    assert.deepEqual(f.ws.setTitleCalls, ['派希丝的家'])

    // 名字没变：不再改名
    await ensureHome({ ctx: f.ctx, root, name: '派希丝' })
    assert.equal(f.sc.calls.rename.length, 2)
    assert.equal(readHome(root).sessionTitle, '与派希丝聊天')
    assert.equal(readHome(root).name, '派希丝')
  })
})

// ---------------------------------------------------------------------------
// 服务晚就绪：拿到 null 不能一次就放弃（n47 同类坑）
// ---------------------------------------------------------------------------

test('home：ensureHomeWithRetry 等到 workspaceRegistry 出现（前两次 null、第三次可用）', async () => {
  await withRoot(async (root) => {
    const f = makeFakes()
    let regGets = 0
    const ctx = {
      get: (n) => {
        if (n === 'workspaceRegistry') {
          regGets += 1
          return regGets >= 3 ? f.reg : null
        }
        return n === 'sessionController' ? f.sc : null
      },
    }
    const waits = []
    const logs = []
    const r = await ensureHomeWithRetry({
      ctx,
      root,
      name: '派希丝',
      log: (m) => logs.push(String(m)),
      retryMs: 5,
      wait: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    assert.equal(r.ok, true)
    assert.equal(regGets, 3, '两次 null 之后第三次才拿到')
    assert.equal(waits.length, 2, '等两次')
    assert.deepEqual(waits, [5, 5], '每次等 retryMs')
    assert.deepEqual(
      logs.filter((l) => l.startsWith('家：等工作区服务')),
      ['家：等工作区服务（第 1 次）', '家：等工作区服务（第 2 次）'],
      '只有重试时才 log',
    )
    assert.equal(existsSync(homeFile(root)), true)
    assert.equal(readHome(root).sessionId, r.sessionId)
    assert.equal(f.sc.calls.create.length, 1, '成功那次才建会话')
  })
})

test('home：一直没服务 → 重试 max 次后失败，reason 带「重试 N 次仍没有」', async () => {
  await withRoot(async (root) => {
    const ctx = { get: () => null }
    let waits = 0
    const r = await ensureHomeWithRetry({
      ctx,
      root,
      max: 2,
      retryMs: 5,
      wait: () => {
        waits += 1
        return Promise.resolve()
      },
    })

    assert.equal(r.ok, false)
    assert.equal(r.retryable, true)
    assert.match(r.reason, /宿主没有 workspaceRegistry 服务/)
    assert.match(r.reason, /重试 2 次仍没有/)
    assert.equal(waits, 2, 'max=2 → 正好重试两次')
    assert.equal(existsSync(homeFile(root)), false)
  })
})

test('home：服务缺失才 retryable；文件写不进去这类失败不带 retryable', async () => {
  await withRoot(async (root) => {
    // 1) 没有 workspaceRegistry
    const noReg = await ensureHome({ ctx: { get: () => null }, root })
    assert.equal(noReg.ok, false)
    assert.equal(noReg.retryable, true)

    // 2) 有 registry、没有 sessionController（工作区建好了，会话建不了 → 也可重试）
    const f = makeFakes()
    const base2 = path.join(root, 'two')
    const noSc = await ensureHome({
      ctx: { get: (n) => (n === 'workspaceRegistry' ? f.reg : null) },
      root: base2,
    })
    assert.equal(noSc.ok, false)
    assert.equal(noSc.retryable, true)
    assert.match(noSc.reason, /sessionController/)

    // 3) 文件系统问题不是「服务缺失」：root 本身是个文件 → 家目录建不出来，不重试
    const notADir = path.join(root, 'not-a-dir')
    writeFileSync(notADir, 'x', 'utf8')
    const bad = await ensureHome({ ctx: f.ctx, root: notADir })
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /家目录建不出来/)
    assert.equal(bad.retryable, undefined, '这类失败再等也不会好，不带 retryable')
  })
})
