import test from 'node:test'
import assert from 'node:assert/strict'
import { WELCOME, ROOM_REMINDER_REPEAT, roomReminderMessages } from '../lib/welcome.js'

test('welcome：定稿文案没有 5 处冲突', () => {
  // 1. 选项 2：改不了了
  assert.match(WELCOME.option2, /我还有个姐姐/)
  assert.match(WELCOME.option2, /改不了了/)
  // 2. 派希丝是姐姐，不是长女/女儿
  assert.ok(!WELCOME.pisces.includes('长女'))
  assert.match(WELCOME.pisces, /姐姐/)
  // 3. 选项 3 是两姐妹一起进客厅，不是只带一个妹妹
  assert.match(WELCOME.pisces, /我们两个会一起进客厅/)
  assert.ok(!WELCOME.pisces.includes('其中一个妹妹'))
  // 4. 客厅提醒只发一次；单独派希丝提醒能回看
  assert.match(WELCOME.pisces, /提醒能回看/)
  assert.match(WELCOME.roomReminder, /只发这一次/)
  // 5. 成长设置口径：是=两个库，否=虚拟；不写客服腔
  assert.match(WELCOME.roomReminder, /两个库/)
  assert.match(WELCOME.roomReminder, /虚拟/)
  assert.match(WELCOME.roomReminder, /不落库/)
  assert.ok(!WELCOME.roomReminder.includes('不能使用任何工具'))
  assert.ok(!WELCOME.roomReminder.includes('不明白的你可以问我'))
})

test('welcome：客厅提醒 3 条相同', () => {
  assert.equal(ROOM_REMINDER_REPEAT, 3)
  const msgs = roomReminderMessages()
  assert.equal(msgs.length, 3)
  assert.ok(msgs.every((m) => m === WELCOME.roomReminder))
})
