import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensurePiscesHome, piscesHomePaths, readPiscesHome } from '../lib/pisces-home.js'

function fakeCtx() {
  const ws = { id: 'ws_p', title: '', sessionIds: [] }
  const sessions = new Map()
  const registry = {
    list: () => [ws],
    create: (dir, title) => { ws.title = title; return ws },
    get: (id) => (id === ws.id ? ws : null),
    rename: (id, title) => { ws.title = title },
  }
  const sc = {
    create: ({ workspaceId }) => {
      const id = `sess_${sessions.size + 1}`
      sessions.set(id, { id, workspaceId })
      ws.sessionIds.push(id)
      return { sessionId: id }
    },
    rename: () => {},
  }
  return { get: (name) => (name === 'workspaceRegistry' ? registry : name === 'sessionController' ? sc : null) }
}

test('pisces-home：独立目录/标题/指针', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-p-home-'))
  try {
    const r = await ensurePiscesHome({ ctx: fakeCtx(), root })
    assert.equal(r.ok, true)
    assert.ok(r.dir.endsWith(path.join('banks', 'pisces', 'home')))
    assert.equal(r.workspaceTitle, '派希丝的家')
    assert.equal(r.sessionTitle, '与派希丝单独聊天')
    const saved = readPiscesHome(root)
    assert.equal(saved.sessionId, r.sessionId)
    assert.equal(saved.workspaceTitle, '派希丝的家')
    assert.equal(piscesHomePaths(root).file, path.join(root, 'banks', 'pisces', 'home.json'))
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 清不掉不挡测试 */ }
  }
})
