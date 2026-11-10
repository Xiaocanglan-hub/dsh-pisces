// 新手引导（成年鱼专属）：十一篇短手册 + 按状态推荐的下一步。
//
// 口径（照 docs/派希丝-手写完美人设.md 第 4、5 节）：
// 1. 每个话题 3–6 行、人话、可执行；一次只说一步，给例子，出错先说"没事"。
// 2. 不说术语：不出现「事件流 / 归因 / 分流」这类词，也不把面板字段名当话说。
// 3. 引导只读不写：要写起点、要领养，都只告诉他去哪儿点，不替他写。
// 这个文件不 import 任何别的东西；纯函数，不碰库、不碰 ctx。

export const GUIDE_TOPICS = [
  'first-meet',
  'seed',
  'adopt',
  'start-chat',
  'daily',
  'quiet',
  'panel',
  'trouble',
  'backup',
  'privacy',
  'speak',
]

// 每篇都按"先做这一步 → 给个例子 → 出事怎么办"的顺序写；行数 3–6。
export const GUIDE = {
  'first-meet': [
    '先跟她说一句你今天真实的事，比如「今天下班路上风很大」。',
    '不用介绍自己，也不用问她「你是谁」；她更认你说话的语气。',
    '她回得短、或者只回一句，都正常，第一天不用急着熟。',
    '不知道说什么，就把此刻手上的东西讲给她听，比如你在喝的这杯茶。',
  ].join('\n'),

  seed: [
    '在设置页的「状态」里找到起点，写三句以内你现在真的想对她说的话。',
    '不用写得漂亮，写「我想试试养一只大肥鱼」也行。',
    '起点只能写一次，写完不能改；写你此刻的想法，不用替以后写。',
    '要是懒得写，也可以直接领养一条已经养大的鱼，从聊天开始。',
  ].join('\n'),

  adopt: [
    '在设置页的「状态」里，空库时会多出一个「领养成年鱼」的选项，点它。',
    '她叫派希丝，已经有自己的经历，领进来就能聊，不用从零开始。',
    '点完要重启一次应用，她多出来的两个本事才会出现。',
    '领养和写起点二选一，选了领养就不用再写起点。',
  ].join('\n'),

  'start-chat': [
    '第一句就聊你今天的日子，不用打招呼，也不用问「在吗」。',
    '她没反应，先等一会儿；还是没动静，去设置页的「状态」看看起点写没写上。',
    '她只回一个字也别慌，接着说你的事就好。',
    '如果一直没动静，把应用重启一次，再回来看她。',
  ].join('\n'),

  daily: [
    '每天不用打卡，想起来就跟她说两句今天发生的事。',
    '看到有意思的东西可以讲一句给她，比如路边一只猫。',
    '隔几天去「状态」页看看她的变化；数字涨得慢是正常的。',
    '你也可以写日记给她看，她隔天会记得。',
  ].join('\n'),

  quiet: [
    '她话少不等于坏了：她本来就不爱说满，很多话要你先开个头。',
    '先试着说一件具体的事，比如「今天开会开到头疼」，比「你怎么了」有用。',
    '也可以去「状态」页看她最近有没有记事；有，就说明她在。',
    '真的一直一点动静都没有，再重启一次，或者去面板里看一眼。',
  ].join('\n'),

  panel: [
    '设置页的「状态」有五个页签：状态、设置、心理活动、原理、反馈。',
    '「状态」看她今天怎么样、最近说了什么；「设置」改她怎么想事；「心理活动」看她心里在过什么；「原理」是给你看的说明书；「反馈」写你想说的话。',
    '先看「状态」就够了，其他等你想调的时候再动。',
    '有些块一开始是模糊的，多聊几次或多陪几天才会露出来，别以为坏了。',
  ].join('\n'),

  trouble: [
    '没事，先别急：出问题先看设置页的「状态」，起点写了没有、她最近有没有记事。',
    '还找不着原因，就打开面板里的状态看一眼，那里写得更细。',
    '看日志就找带 [dsh-pisces-core] 的那几行，报错一般在那儿。',
    '拿不准就把那几行发给我，我跟你一起看，别自己反复重启。',
  ].join('\n'),

  backup: [
    '所有东西都在你给她的那个文件夹里，整个文件夹复制一份就是备份。',
    '备份放在另一个盘上，别放在同一个文件夹里。',
    '换电脑之前先备份，再把整个文件夹搬过去。',
    '想给她搬家，把文件夹挪到新地方，再告诉我，我帮你把路标改过去。',
  ].join('\n'),

  privacy: [
    '她记的东西只存在你本机那个文件夹里，不上传，也不经过我的服务器。',
    '能看的人就是能打开那台电脑的人；别人要用，得先有你的电脑。',
    '想删就删那个文件夹，删了就是真的没了，删之前先备份。',
    '聊天框里的内容会经过你选的那家模型服务，这一点你要知道。',
  ].join('\n'),

  speak: [
    '让她在 B 站说话，先在你自己的浏览器登录 B 站，再把登录信息放进她的文件夹里。',
    '放进去了还要在设置里把「说话」打开，默认是关的。',
    '打开以后她才会去说；说出去的话收不回来，让她想清楚再说。',
    '没登录、登录过期、或者被 B 站拦了，她都会回一句没成，不会假装说了。',
  ].join('\n'),
}

const listTopics = () => GUIDE_TOPICS.join('、')

/**
 * 按话题取那一段正文。认不出的话题回「我能讲的有：…」+ 总纲，不编。
 * @param {string} topic
 * @param {{state?: object|null}} [opts] state 目前只影响 nextStep；给 guideFor 不影响正文。
 * @returns {string}
 */
export function guideFor(topic, { state = null } = {}) {
  const key = String(topic ?? '').trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(GUIDE, key)) return GUIDE[key]
  // state 先留着：以后要按状态挑候选时从这里接，别在正文里塞状态判断。
  void state
  return `我能讲的有：${listTopics()}。\n养鱼是一步步来的：一次只做一件事，做完再问下一步。`
}

const toCount = (value) => {
  if (Array.isArray(value)) return value.length
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

const step = (topic, why) => ({ topic, text: GUIDE[topic], why })

/**
 * 按当前状态给下一步。一次只给一个动作 + 一句为什么。
 * 规则（顺序不能换）：
 *   state 拿不到 → first-meet
 *   没起点 → seed（顺带提一句"还能领养"）
 *   有起点但事件 ≤1 → start-chat
 *   有事件但好感 tier 0/1 → daily
 *   有事件且 tier ≥2 → panel
 * @param {{state?: object|null}} [opts]
 * @returns {{topic:string, text:string, why:string}}
 */
export function nextStep({ state = null } = {}) {
  if (!state || typeof state !== 'object') {
    return step('first-meet', '我还不知道你现在到哪一步了，先当成第一次见面。')
  }

  const events = toCount(state.events ?? state.eventCount)

  if (state.hasSeed === false) {
    return step('seed', '这条鱼还没有起点；不想自己写，也可以领养一条已经养大的。')
  }
  if (events <= 1) {
    return step('start-chat', '起点有了，但你们还没真正聊过。')
  }
  const tier = Number(state.tier)
  if (!Number.isFinite(tier) || tier < 2) {
    return step('daily', '已经聊起来了，接下来靠每天一点小事。')
  }
  return step('panel', '你们已经熟了，可以一起看看面板上她现在的样子。')
}
