import test from 'node:test'
import assert from 'node:assert/strict'
import { composeRoom, detectTeaching, lessonText, monitorVerdict, oneSentence, parseMentions } from '../lib/room.js'
import { lessonById } from '../lib/lessons.js'

test('room：点名支持 @/自然叫法，两种都认', () => {
  assert.deepEqual(parseMentions('@派希丝 你说'), { pisces: true, fish: false })
  assert.deepEqual(parseMentions('派希丝，你说'), { pisces: true, fish: false })
  assert.deepEqual(parseMentions('@普通鱼 你来说'), { pisces: false, fish: true })
  assert.deepEqual(parseMentions('妹妹，你来说'), { pisces: false, fish: true })
  assert.deepEqual(parseMentions('今天好累'), { pisces: false, fish: false })
})

test('room：只留一句', () => {
  assert.equal(oneSentence('一。二。三。'), '一。')
  assert.equal(oneSentence('一！二'), '一！')
  assert.equal(oneSentence('没有标点'), '没有标点')
  assert.equal(oneSentence('  '), '')
})

test('room：拼接只放说了的角色', () => {
  assert.equal(composeRoom({ fish: '一。', pisces: '二。' }), '【普通鱼】一。\n【派希丝】二。')
  assert.equal(composeRoom({ fish: '一。' }), '【普通鱼】一。')
  assert.equal(composeRoom({ pisces: '二。' }), '【派希丝】二。')
  assert.equal(composeRoom({}), '')
})

test('room：监测三分支 NO / 补一句 / 点名妹妹 / 教学', () => {
  assert.deepEqual(monitorVerdict('NO'), { speak: false })
  assert.deepEqual(monitorVerdict(''), { speak: false })
  assert.deepEqual(monitorVerdict('不'), { speak: false })
  const speak = monitorVerdict('我补一句。后面还有。')
  assert.equal(speak.speak, true)
  assert.equal(speak.text, '我补一句。')
  const call = monitorVerdict('@普通鱼 你来说。')
  assert.equal(call.callFish, true)
  const teach = monitorVerdict('TEACH\n先给判断。')
  assert.equal(teach.teach, true)
  assert.equal(teach.text, '先给判断。')
})

test('room：教学库能接到一条课', () => {
  const lesson = detectTeaching('他问我怎么办，我拿不定')
  assert.equal(lesson.id, 'judgment-first')
  assert.match(lessonText(lessonById('stop-after-two')), /两句说完就停/)
  assert.equal(detectTeaching('今天天气不错'), null)
})
