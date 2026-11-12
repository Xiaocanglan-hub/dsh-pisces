import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SETUP_MODES,
  addSister,
  createSetup,
  markRoomWelcomeSent,
  needsRoomWelcome,
  soloChat,
  welcomeKind,
  welcomeStored,
} from '../lib/setup.js'

test('setup：1 姐姐，默认不锁，能后加妹妹变两库+客厅', () => {
  const p = createSetup({ mode: 'pisces', now: () => 123 })
  assert.equal(p.mode, 'pisces')
  assert.deepEqual(p.banks, ['pisces'])
  assert.equal(p.room, false)
  assert.equal(p.locked, false)
  assert.equal(p.createdAt, 123)
  const r = addSister(p)
  assert.equal(r.ok, true)
  assert.equal(r.setup.mode, 'both')
  assert.equal(r.setup.together, true)
  assert.deepEqual(r.setup.banks, ['sister', 'pisces'])
  assert.equal(r.setup.room, true)
  assert.equal(r.setup.locked, true)
  assert.equal(r.setup.addedSister, true)
})

test('setup：2 妹妹锁死，不能加派希丝', () => {
  const s = createSetup({ mode: 'sister' })
  assert.equal(s.mode, 'sister')
  assert.deepEqual(s.banks, ['sister'])
  assert.equal(s.room, false)
  assert.equal(s.locked, true)
  assert.equal(addSister(s).ok, false)
  assert.deepEqual(soloChat(s), { sister: true, pisces: false })
})

test('setup：3 虚拟/一同成长两库，且只在开局定', () => {
  const no = createSetup({ mode: 'both', together: false })
  assert.deepEqual(no.banks, ['sister'])
  assert.equal(no.virtualPisces, true)
  assert.equal(no.room, true)
  assert.equal(no.locked, true)
  assert.deepEqual(soloChat(no), { sister: true, pisces: false })

  const yes = createSetup({ mode: 'both', together: true })
  assert.deepEqual(yes.banks, ['sister', 'pisces'])
  assert.equal(yes.virtualPisces, false)
  assert.deepEqual(soloChat(yes), { sister: true, pisces: true })
})

test('setup：welcome 类型与客厅布尔', () => {
  assert.equal(welcomeKind(createSetup({ mode: 'pisces' })), 'solo-pisces')
  assert.equal(welcomeStored(createSetup({ mode: 'pisces' })), true)
  assert.equal(welcomeStored(createSetup({ mode: 'sister' })), false)
  const room = createSetup({ mode: 'both', together: false })
  assert.equal(welcomeKind(room), 'room')
  assert.equal(welcomeStored(room), false)
  assert.equal(needsRoomWelcome(room), true)
  const sent = markRoomWelcomeSent(room)
  assert.equal(sent.roomWelcomeSent, true)
  assert.equal(needsRoomWelcome(sent), false)
})

test('setup：非法 mode 直接抛；对象只读', () => {
  assert.throws(() => createSetup({ mode: 'x' }), /unknown setup mode/)
  const p = createSetup()
  assert.equal(Object.isFrozen(p), true)
  assert.equal(SETUP_MODES.length, 3)
})
