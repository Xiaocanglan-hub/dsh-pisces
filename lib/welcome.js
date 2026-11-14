// 开场与客厅提醒的定稿文案（2026-11-12 用户人工改回）。
// 口径：派希丝是姐姐不是女儿；选项 3 是两姐妹都进客厅；
// 客厅聊天正常落库；只有开局这 3 条提醒不落库、不写 welcome 事件，只显示一次。
// 单独派希丝的 welcome 可回看。
// 2026-11-13：本机 cast 另有短版（鲸歌姐姐/派希丝妹妹），见 WELCOME_LOCAL。
import { isLocalCast } from './cast.js'

export const WELCOME = Object.freeze({
  option2: `我还有个姐姐，叫派希丝。这次只领养了我，她不在这个家里。

选了我之后，就改不了了。`,
  pisces: `我是派希丝，我是姐姐，我还有一个妹妹。你可以只领我，也可以同时领我和妹妹，我们两个会一起进客厅。

单独选我的话，以后也能再领养妹妹；提醒能回看。客厅只聊天，提醒只发一次。`,
  roomReminder: `重要提醒：一定要仔细查看设置页

派希丝是否一同成长只能开局选一次，之后改不了；选是，两个库姐妹俩都能够成长；选否，不建第二个库，派希丝将作为虚拟角色出现在客厅，也不能单独和派希丝聊天。

客厅只能聊天；这条提醒不落库，只发这一次。`,
})

export const ROOM_REMINDER_REPEAT = 3

// 本机短版：只陈述关系，不复述发布版的三选项/成长设置。台词等 DS 再润（n119）。
export const WELCOME_LOCAL = Object.freeze({
  option2: '我是鲸歌。派希丝是我妹妹，她也在。',
  pisces: '我是派希丝，鲸歌是我姐姐。她也在。',
})

/** 按当前 cast 取开场：本机走短版，发布走定稿。 */
export function welcomeText(kind) {
  const src = isLocalCast() ? WELCOME_LOCAL : WELCOME
  return kind === 'pisces' ? src.pisces : src.option2
}

/** 客厅第一次进：同一条提醒连发 3 次（3 条独立消息，内容相同）。 */
export function roomReminderMessages() {
  return Array.from({ length: ROOM_REMINDER_REPEAT }, () => WELCOME.roomReminder)
}
