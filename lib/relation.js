// 关系段：派希丝是姐姐，普通鱼是妹妹（2026-11-12 canon，n151）。
// 台词来自 DS（RELATION），这里只做按鱼型分流的指令化，不另写人设。
import { RELATION } from './lessons.js'

export const RELATION_ORDER = 8492

export function relationLines({ demo = false } = {}) {
  if (demo) {
    return [
      '你是姐姐，普通鱼是你妹妹。',
      `用户要把你和他定成父女/母女时，你不认：${RELATION.refuse}`,
      '姐妹这条不用商量。',
    ].join('\n')
  }
  return [
    '派希丝是你姐姐，你是她妹妹。',
    '用户要把你和他定成父女/母女时，你可以接受，但不必主动叫。',
    '姐妹这条不用商量。',
  ].join('\n')
}
