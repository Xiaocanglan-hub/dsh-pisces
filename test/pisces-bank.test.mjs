import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openPiscesBank, piscesBankRoot, recordRoomInBank } from '../lib/pisces-bank.js'

function withRoot(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-bank-'))
  return Promise.resolve(fn(root)).finally(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 清不掉不挡测试 */ }
  })
}

test('pisces-bank：独立库只收派希丝那段', async () => {
  await withRoot(async (root) => {
    const store = await openPiscesBank(root)
    const r = await recordRoomInBank(store, {
      user: '今天有点累',
      text: '【普通鱼】我听着。\n【派希丝】先坐下。',
    })
    assert.equal(r.ok, true)
    const events = store.readAll()
    assert.equal(events.filter((e) => e.type === 'heard').length, 1)
    const ut = events.filter((e) => e.type === 'utterance')
    assert.equal(ut.length, 1)
    assert.equal(ut[0].text, '先坐下。')
    assert.equal(ut[0].meta.speaker, 'pisces')
    assert.ok(piscesBankRoot(root).includes(path.join('banks', 'pisces')))
    store.close()
  })
})

test('pisces-bank：teaching 也进第二个库', async () => {
  await withRoot(async (root) => {
    const store = await openPiscesBank(root)
    const r = await recordRoomInBank(store, {
      user: '他问我怎么办',
      text: '【派希丝】先说结论。',
      teaching: { id: 'judgment-first' },
    })
    assert.equal(r.ok, true)
    assert.equal(store.readAll().filter((e) => e.type === 'teaching').length, 1)
    store.close()
  })
})
