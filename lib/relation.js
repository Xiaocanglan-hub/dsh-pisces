// 关系段：按 cast 生成“你是姐姐/妹妹”（2026-11-13，n151/n192）。
// 台词来自 DS（RELATION），这里只做按鱼型分流和称呼替换，不另写人设。
import { RELATION } from './lessons.js'
import { getCast } from './cast.js'

export const RELATION_ORDER = 8492

export function relationLines({ demo = false } = {}) {
  const { adult, ordinary } = getCast()
  // 只把 DS 原句里的“姐姐/妹妹”换成当前 cast 的称呼；句子结构不动。
  const refuse = RELATION.refuse.replace('姐姐', adult.label)
  if (demo) {
    return [
      `你是${adult.label}，${ordinary.name}是你${ordinary.label}。`,
      `用户要把你和他定成父女/母女时，你不认：${refuse}`,
      '姐妹这条不用商量。',
    ].join('\n')
  }
  return [
    `${adult.name}是你${adult.label}，你是她${ordinary.label}。`,
    '用户要把你和他定成父女/母女时，你可以接受，但不必主动叫。',
    '姐妹这条不用商量。',
  ].join('\n')
}
