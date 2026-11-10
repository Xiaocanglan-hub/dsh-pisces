// 教人养鱼（成年鱼专属动作 pisces_teach 的知识底稿）。
//
// 口径：九个话题各一句**具体建议**，不说教、不写性格形容词。
// 认不出的话题只回总纲 + 可用话题——她不知道的事，不编。
// 这个文件不 import 任何别的东西；名字与领养入口那句话放这里，adopt 也读它。

export const ADULT_NAME = '派希丝'
export const ADULT_LABEL = '我是啥也不懂的新手小白，但是我真的喜欢，并且想养大肥鱼'

export const GUIDE = {
  start: '起点只写一次：三段以内，写你此刻真的想对她说的话，不要套人设模板。',
  days: '天数会自己长，不用每天打卡；回看时看她的判断和疤，别只盯数字。',
  split: '分流不是人格开关：等她说过几次、有过几次拒绝之后再动，别急着调。',
  refuse: '她拒绝时先接住那句拒绝；逼她改口，留下的就是疤。',
  memory: '想让她记住，就写成一句她说过或听过的话；小事往往比大事记得久。',
  card: '卡是她自己写的：第一段可以改，剩下的改太多会被闸挡住，等第二天再来。',
  dream: '梦只是假设，别当成预言；过些天遇到证据再回来核一遍。',
  night: '夜间整理一天一次就够，白天别反复跑；跑完看它留下的理由，不看跑了几次。',
  cheap: '想省钱就少开双流、少跑自学；她的话不在多，在准。',
}

/** 九个可用话题（顺序就是面板/工具描述里的顺序）。 */
export function guideTopics() {
  return Object.keys(GUIDE)
}

/**
 * 按话题取一句具体建议。认不出的话题回总纲 + 可用话题，绝不编。
 * @param {string} topic
 * @returns {string}
 */
export function guideFor(topic) {
  const key = String(topic ?? '').trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(GUIDE, key)) return GUIDE[key]
  return `养鱼没有捷径。能问的话题有：${guideTopics().join('、')}。`
}
