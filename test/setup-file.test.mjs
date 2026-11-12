import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSetup, setupPath, writeSetup } from '../lib/setup-file.js'
import { addSister, createSetup, markRoomWelcomeSent } from '../lib/setup.js'

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-setup-'))
  try {
    return fn(root)
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 清不掉不挡测试 */ }
  }
}

test('setup-file：缺文件 / 坏 JSON / 坏 mode 都回 null', () => {
  withRoot((root) => {
    assert.equal(readSetup(root), null)
    writeFileSync(setupPath(root), '{bad', 'utf8')
    assert.equal(readSetup(root), null)
    writeFileSync(setupPath(root), JSON.stringify({ mode: 'x' }), 'utf8')
    assert.equal(readSetup(root), null)
  })
})

test('setup-file：1 姐姐写读；加妹妹后仍是 both+addedSister', () => {
  withRoot((root) => {
    const p = createSetup({ mode: 'pisces', now: () => 123 })
    assert.equal(writeSetup(root, p).ok, true)
    const back = readSetup(root)
    assert.equal(back.mode, 'pisces')
    assert.deepEqual(back.banks, ['pisces'])
    assert.equal(back.createdAt, 123)

    const both = addSister(p).setup
    assert.equal(writeSetup(root, both).ok, true)
    const back2 = readSetup(root)
    assert.equal(back2.mode, 'both')
    assert.equal(back2.together, true)
    assert.equal(back2.addedSister, true)
    assert.deepEqual(back2.banks, ['sister', 'pisces'])
    assert.equal(back2.room, true)
  })
})

test('setup-file：3 虚拟/两库与客厅布尔往返', () => {
  withRoot((root) => {
    const no = createSetup({ mode: 'both', together: false })
    assert.equal(writeSetup(root, no).ok, true)
    const back = readSetup(root)
    assert.equal(back.together, false)
    assert.equal(back.virtualPisces, true)
    assert.deepEqual(back.banks, ['sister'])

    const sent = markRoomWelcomeSent(no)
    assert.equal(writeSetup(root, sent).ok, true)
    assert.equal(readSetup(root).roomWelcomeSent, true)
  })
})
