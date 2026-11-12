import test from 'node:test'
import assert from 'node:assert/strict'
import { planSetup } from '../lib/setup-choice.js'

test('setup-choice：1 姐姐要领养，已领养就不动', () => {
  const p = planSetup({ mode: 'pisces' })
  assert.equal(p.ok, true)
  assert.deepEqual(p.actions, ['adopt'])
  assert.equal(p.setup.mode, 'pisces')
  assert.deepEqual(planSetup({ mode: 'pisces', hasDemo: true }).actions, [])
})

test('setup-choice：2 妹妹要起点，且没有派希丝库', () => {
  const s = planSetup({ mode: 'sister' })
  assert.equal(s.ok, true)
  assert.deepEqual(s.actions, ['seed'])
  assert.deepEqual(s.setup.banks, ['sister'])
  assert.equal(s.needsPiscesBank, false)
  assert.deepEqual(planSetup({ mode: 'sister', hasSeed: true }).actions, [])
})

test('setup-choice：3 全都要，together 决定要不要派希丝库', () => {
  const no = planSetup({ mode: 'both', together: false, hasSeed: true })
  assert.equal(no.ok, true)
  assert.equal(no.needsPiscesBank, false)
  assert.deepEqual(no.setup.banks, ['sister'])

  const yes = planSetup({ mode: 'both', together: true, hasSeed: true })
  assert.equal(yes.needsPiscesBank, true)
  assert.deepEqual(yes.setup.banks, ['sister', 'pisces'])
})

test('setup-choice：已选过 / 非法模式都拒绝', () => {
  assert.equal(planSetup({ mode: 'pisces', hasSetup: true }).ok, false)
  assert.equal(planSetup({ mode: 'x' }).ok, false)
})
