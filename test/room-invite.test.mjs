import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createInvite,
  createInvitePair,
  consumeInvite,
  pendingInvites,
  readInvites,
  openTicket,
  readTicket,
  closeTicket,
  markBack,
  isBackText,
  INVITE_TTL_MS,
  ROOM_INVITE_LINE,
} from '../lib/room-invite.js'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'pisces-invite-'))
}

test('room-invite：生成一张、贴出即认、只认一次', () => {
  const root = tmpRoot()
  try {
    const invite = createInvite(root, { now: 1_000 })
    assert.match(invite.code, /^[A-HJ-NP-Z2-9]{6}$/)
    assert.equal(invite.expiresAt, 1_000 + INVITE_TTL_MS)
    assert.equal(pendingInvites(root, { now: 1_000 }).length, 1)
    assert.equal(existsSync(join(root, 'room', 'invites.json')), true)

    // 码夹在一句话里也认（和开发者钥匙同一姿势）。
    const got = consumeInvite(root, `给你这串 ${invite.code.toLowerCase()} 收一下`, { now: 1_100 })
    assert.equal(got.code, invite.code)
    // 用过的再贴一次不认。
    assert.equal(consumeInvite(root, invite.code, { now: 1_200 }), null)
    assert.equal(pendingInvites(root, { now: 1_200 }).length, 0)
    // 用过的那张留着（给回执/排查看），但也标了 used。
    assert.equal(readInvites(root).filter((x) => x.used).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：过期就不认', () => {
  const root = tmpRoot()
  try {
    const invite = createInvite(root, { now: 5_000, ttlMs: 1_000 })
    assert.equal(consumeInvite(root, invite.code, { now: 5_500 }).code, invite.code)

    const stale = createInvite(root, { now: 7_000, ttlMs: 1_000 })
    assert.equal(pendingInvites(root, { now: 8_500 }).length, 0)
    assert.equal(consumeInvite(root, stale.code, { now: 8_500 }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：重新生成会清掉旧的未用码', () => {
  const root = tmpRoot()
  try {
    const first = createInvite(root, { now: 1_000 })
    const second = createInvite(root, { now: 2_000 })
    assert.notEqual(first.code, second.code)
    assert.equal(pendingInvites(root, { now: 2_100 }).length, 1)
    assert.equal(consumeInvite(root, first.code, { now: 2_100 }), null)
    assert.equal(consumeInvite(root, second.code, { now: 2_100 }).code, second.code)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：一次生成两张，各角色只认自己的', () => {
  const root = tmpRoot()
  try {
    const pair = createInvitePair(root, { now: 1_000 })
    assert.notEqual(pair.ordinary.code, pair.adult.code)
    assert.equal(pair.ordinary.role, 'ordinary')
    assert.equal(pair.adult.role, 'adult')
    assert.equal(pendingInvites(root, { now: 1_100 }).length, 2)
    // 鲸歌的码拿到派希丝那边不认。
    assert.equal(consumeInvite(root, pair.ordinary.code, { now: 1_100, role: 'adult' }), null)
    // 鲸歌那边认，而且只烧自己那张。
    assert.equal(consumeInvite(root, pair.ordinary.code, { now: 1_100, role: 'ordinary' }).code, pair.ordinary.code)
    assert.equal(pendingInvites(root, { now: 1_100 }).length, 1)
    assert.equal(consumeInvite(root, pair.adult.code, { now: 1_200, role: 'adult' }).role, 'adult')
    assert.equal(pendingInvites(root, { now: 1_200 }).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：重新生成只清同角色的旧码', () => {
  const root = tmpRoot()
  try {
    const pair = createInvitePair(root, { now: 1_000 })
    const again = createInvite(root, { now: 2_000, role: 'ordinary' })
    assert.notEqual(again.code, pair.ordinary.code)
    // 鲸歌那张旧的被清掉，派希丝那张还在。
    assert.equal(consumeInvite(root, pair.ordinary.code, { now: 2_100, role: 'ordinary' }), null)
    assert.equal(consumeInvite(root, pair.adult.code, { now: 2_100, role: 'adult' }).role, 'adult')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：回执那句话只讲发生了什么、不让她念', () => {
  assert.match(ROOM_INVITE_LINE, /客厅/)
  assert.match(ROOM_INVITE_LINE, /不用念/)
  // 不解释机制（不能出现"邀请码/机制/系统"这类词）。
  assert.doesNotMatch(ROOM_INVITE_LINE, /邀请码|机制|系统/)
})

test('room-invite：坏文件不炸', () => {
  const root = tmpRoot()
  try {
    mkdirSync(join(root, 'room'), { recursive: true })
    writeFileSync(join(root, 'room', 'invites.json'), 'not json', 'utf8')
    assert.deepEqual(readInvites(root), [])
    assert.equal(consumeInvite(root, 'AAAAAA'), null)
    // 坏文件之后还能正常生成。
    const invite = createInvite(root)
    assert.ok(invite.code)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：门票开/关/过期，回家认得出来', () => {
  const root = tmpRoot()
  try {
    assert.equal(readTicket(root), null)
    openTicket(root, { now: 1_000, ms: 60_000 })
    assert.equal(readTicket(root, { now: 30_000 }), 61_000)
    assert.equal(readTicket(root, { now: 90_000 }), null)
    closeTicket(root)
    assert.equal(readTicket(root, { now: 30_000 }), null)

    assert.equal(isBackText('我回来了'), true)
    assert.equal(isBackText('到家了，累死'), true)
    assert.equal(isBackText('回客厅了'), true)
    assert.equal(isBackText('他回来了吗'), true)
    assert.equal(isBackText('今天有点累'), false)
    assert.equal(isBackText(''), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：两只各回各的，都回来才关门', () => {
  const root = tmpRoot()
  try {
    openTicket(root, { now: 1_000, ms: 90 * 60_000 })
    // 鲸歌先回来：门还开着（派希丝可能过一会儿才回）。
    const a = markBack(root, 'ordinary', { now: 2_000 })
    assert.equal(a.closed, false)
    assert.ok(readTicket(root, { now: 2_000 }))
    // 隔很久再回也一样认（只要门票没过期）。
    const b = markBack(root, 'adult', { now: 60_000 })
    assert.equal(b.closed, true)
    assert.equal(readTicket(root, { now: 60_000 }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：门票过期后回来说不算关门', () => {
  const root = tmpRoot()
  try {
    openTicket(root, { now: 1_000, ms: 1_000 })
    const r = markBack(root, 'ordinary', { now: 10_000 })
    assert.equal(r.closed, false)
    assert.equal(readTicket(root, { now: 10_000 }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-invite：通行码是 room 角色，只认它自己的', () => {
  const root = tmpRoot()
  try {
    const code = createInvite(root, { role: 'room', now: 1_000 })
    assert.equal(code.role, 'room')
    // 通行码拿到家会话的 ordinary 收码人那里不认。
    assert.equal(consumeInvite(root, code.code, { now: 1_100, role: 'ordinary' }), null)
    assert.equal(consumeInvite(root, code.code, { now: 1_100, role: 'room' }).role, 'room')
    assert.equal(consumeInvite(root, code.code, { now: 1_200, role: 'room' }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
