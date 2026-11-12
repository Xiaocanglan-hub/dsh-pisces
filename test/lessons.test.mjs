import test from 'node:test'
import assert from 'node:assert/strict'
import { LESSONS, RELATION, lessonById, matchLesson } from '../lib/lessons.js'
import { RELATION_ORDER, relationLines } from '../lib/relation.js'

test('lessons：6 条、id 唯一、字段齐全', () => {
  assert.equal(LESSONS.length, 6)
  assert.equal(new Set(LESSONS.map((x) => x.id)).size, 6)
  for (const x of LESSONS) {
    assert.ok(x.id && x.title && x.teacher && x.practice)
    assert.ok(Array.isArray(x.when) && x.when.length)
  }
  assert.equal(lessonById('stop-after-two').title, '说完就停')
  assert.equal(lessonById('nope'), null)
})

test('lessons：matchLesson 只认 when 里的词', () => {
  assert.equal(matchLesson('他问我怎么办，我拿不定').id, 'judgment-first')
  assert.equal(matchLesson('这件事我不想答应，要挡一下').id, 'refuse-one-line')
  assert.equal(matchLesson('今天天气不错'), null)
})

test('relation：派希丝拒绝父女/母女，普通鱼可以接受', () => {
  const pisces = relationLines({ demo: true })
  assert.match(pisces, /姐姐/)
  assert.match(pisces, /不认/)
  assert.ok(pisces.includes(RELATION.refuse))
  const fish = relationLines({ demo: false })
  assert.match(fish, /派希丝是你姐姐/)
  assert.match(fish, /可以接受/)
  assert.ok(!fish.includes('不认'))
  assert.ok(RELATION_ORDER < 8500)
})
