import test from 'node:test'
import assert from 'node:assert/strict'
import { inferSetup, migrateSetup } from '../lib/setup-migrate.js'

test('setup-migrate：成年鱼 → pisces；普通起点 → sister；空库 → null', () => {
  assert.equal(inferSetup([]), null)
  assert.equal(inferSetup([{ type: 'utterance' }]), null)

  const demo = inferSetup([{ type: 'meta', meta: { kind: 'demo' } }])
  assert.equal(demo.mode, 'pisces')
  assert.deepEqual(demo.banks, ['pisces'])

  const seed = inferSetup([{ type: 'seed', text: '我是谁' }])
  assert.equal(seed.mode, 'sister')
  assert.deepEqual(seed.banks, ['sister'])
})

test('setup-migrate：已有 setup 不动；补的时候才写', () => {
  const existing = { mode: 'both', together: false }
  let writes = 0
  const r = migrateSetup({
    root: '/x',
    events: [{ type: 'seed', text: 'x' }],
    read: () => existing,
    write: () => { writes++ },
  })
  assert.equal(r.migrated, false)
  assert.equal(r.setup, existing)
  assert.equal(writes, 0)

  const r2 = migrateSetup({
    root: '/x',
    events: [{ type: 'seed', text: 'x' }],
    read: () => null,
    write: () => { writes++ },
  })
  assert.equal(r2.migrated, true)
  assert.equal(r2.setup.mode, 'sister')
  assert.equal(writes, 1)
})
