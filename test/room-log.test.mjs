import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absorbRoomLog, appendRoomLog, readRoomLog } from '../lib/room-log.js'
import { LOCAL_CAST, resetCast, setCast } from '../lib/cast.js'

function fakeStore() {
  const rows = []
  const kv = new Map()
  return {
    rows,
    append: async (e) => {
      rows.push(e)
      return e
    },
    modeGet: (k) => (kv.has(k) ? kv.get(k) : null),
    modeSet: (k, v) => {
      kv.set(k, v)
    },
  }
}

test('room-log：追加、读取、吸收一次；重复吸收不重复写', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pisces-room-log-'))
  try {
    assert.ok(appendRoomLog(root, { user: '今天有点累', fish: '我听着。', pisces: '先坐下。' }))
    assert.ok(appendRoomLog(root, { user: '吃了吗', fish: '吃了。', pisces: 'NO' }))
    const { entries, next } = readRoomLog(root)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].fish, '我听着。')
    assert.equal(entries[1].pisces, 'NO')
    assert.equal(next, 1)

    const store = fakeStore()
    const r1 = await absorbRoomLog({ root, stores: [{ store, role: 'ordinary' }] })
    assert.equal(r1.absorbed, 2)
    // 每轮三条：heard（主人）+ utterance（她自己）+ room（对方那句）。
    assert.equal(r1.recorded, 6)
    assert.equal(store.rows.length, 6)
    assert.deepEqual(store.rows.map((x) => x.type), ['heard', 'utterance', 'room', 'heard', 'utterance', 'room'])
    // 对方那句标明是谁说的：鲸歌这边收的是派希丝的话。
    assert.equal(store.rows[2].meta.speaker, 'adult')
    assert.equal(store.rows[2].text, '先坐下。')

    const r2 = await absorbRoomLog({ root, stores: [{ store, role: 'ordinary' }] })
    assert.equal(r2.absorbed, 0)
    assert.equal(store.rows.length, 6)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-log：decide 的判断会多写一条 note', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pisces-room-log-'))
  try {
    appendRoomLog(root, { user: '他说他累', fish: '先睡。', pisces: '我在。' })
    const store = fakeStore()
    const r = await absorbRoomLog({
      root,
      stores: [{ store, role: 'adult' }],
      decide: ({ role, who }) => (role === 'adult' ? `他说他累（${who.name}记住了）` : null),
    })
    assert.equal(r.recorded, 4)
    assert.equal(store.rows.at(-1).type, 'note')
    assert.match(store.rows.at(-1).text, /记住了/)
    // 派希丝这边收的对方那句是鲸歌说的。
    const roomRow = store.rows.find((x) => x.type === 'room')
    assert.equal(roomRow.meta.speaker, 'ordinary')
    assert.equal(roomRow.text, '先睡。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('room-log：本机 cast 下吸收用鲸歌/派希丝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pisces-room-log-'))
  setCast(LOCAL_CAST)
  try {
    appendRoomLog(root, { user: '在吗', fish: '在。', pisces: '我在。' })
    const store = fakeStore()
    const r = await absorbRoomLog({ root, stores: [{ store, role: 'ordinary' }], decide: ({ who }) => `我是${who.name}` })
    assert.equal(r.recorded, 4)
    assert.match(store.rows.at(-1).text, /我是鲸歌/)
  } finally {
    resetCast()
    rmSync(root, { recursive: true, force: true })
  }
})
