import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roomHomePaths, readRoomHome, ensureRoomHome } from '../lib/room-home.js'

const tmp = mkdtempSync(join(tmpdir(), 'pisces-room-home-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))

test('roomHomePaths 在 <root>/room 下', () => {
  const p = roomHomePaths(tmp)
  assert.equal(p.file, join(tmp, 'room', 'home.json'))
  assert.equal(p.dir, join(tmp, 'room', 'home'))
})

test('readRoomHome：没有文件回 null，坏 JSON 回 null，正常回对象', () => {
  assert.equal(readRoomHome(tmp), null)
  mkdirSync(join(tmp, 'room'), { recursive: true })
  writeFileSync(join(tmp, 'room', 'home.json'), '{bad', 'utf8')
  assert.equal(readRoomHome(tmp), null)
  const home = { wsId: 'w', sessionId: 's', workspaceTitle: '客厅', workspacePath: join(tmp, 'room', 'home') }
  writeFileSync(join(tmp, 'room', 'home.json'), JSON.stringify(home), 'utf8')
  assert.deepEqual(readRoomHome(tmp), home)
})

test('ensureRoomHome：先落占位档，服务缺失时 workspacePath 也在', async () => {
  const root2 = mkdtempSync(join(tmpdir(), 'pisces-room-home2-'))
  try {
    const r = await ensureRoomHome({ ctx: { get: () => null }, root: root2, retryMs: 0, max: 0 })
    assert.equal(r.ok, false)
    const h = readRoomHome(root2)
    assert.equal(h.workspacePath, join(root2, 'room', 'home'))
    assert.equal(h.name, '客厅')
  } finally {
    rmSync(root2, { recursive: true, force: true })
  }
})
