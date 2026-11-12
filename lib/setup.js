// 开局三选项的纯状态规则（2026-11-12 用户定死）。
//
// 1 pisces：姐姐派希丝；以后可加妹妹（加 = 第二个库 + 客厅）。
// 2 sister：只有妹妹；之后不能改，不能加派希丝、不能开客厅。
// 3 both：全都要；together=true 两个库（姐妹都能成长），false 只建妹妹库、派希丝虚拟。
// together 只在 createSetup 时定一次；没有改成 true/false 的入口。
// 客厅提醒只发一次，靠 roomWelcomeSent 布尔（不存正文）。

export const SETUP_MODES = Object.freeze(['pisces', 'sister', 'both'])
export const DEFAULT_SETUP_MODE = 'pisces'

const freeze = (x) => Object.freeze(x)
const banksOf = (mode, together) => {
  if (mode === 'pisces') return freeze(['pisces'])
  if (mode === 'sister') return freeze(['sister'])
  return together ? freeze(['sister', 'pisces']) : freeze(['sister'])
}

/**
 * 建开局。mode 必须合法；together 只在 mode=both 时生效。
 * @returns {Readonly<{mode, together, addedSister, banks, room, virtualPisces, locked, roomWelcomeSent, createdAt}>}
 */
export function createSetup({ mode = DEFAULT_SETUP_MODE, together = false, now = Date.now } = {}) {
  if (!SETUP_MODES.includes(mode)) throw new Error(`unknown setup mode: ${mode}`)
  const both = mode === 'both'
  const togetherNow = both ? Boolean(together) : false
  const created = typeof now === 'function' ? now() : now
  return freeze({
    mode,
    together: togetherNow,
    addedSister: false,
    banks: banksOf(mode, togetherNow),
    room: both,
    // 选否：不建第二个库，派希丝只作为虚拟角色出现在客厅，不能单独聊。
    virtualPisces: both && !togetherNow,
    // 2 和 3 开局即锁死；1 还允许“以后加妹妹”。
    locked: mode !== 'pisces',
    roomWelcomeSent: false,
    createdAt: Number.isFinite(Number(created)) ? Number(created) : Date.now(),
  })
}

/** 选项 1 才能以后加妹妹；加完变成 both + 两个真实库 + 客厅。 */
export function addSister(setup) {
  if (!setup || setup.mode !== 'pisces') {
    return { ok: false, reason: '只有领养姐姐之后才能再加妹妹' }
  }
  return {
    ok: true,
    setup: freeze({
      ...setup,
      mode: 'both',
      together: true,
      addedSister: true,
      banks: freeze(['sister', 'pisces']),
      room: true,
      virtualPisces: false,
      locked: true,
    }),
  }
}

/** 谁能单独聊：选否的客厅里，派希丝不能单独聊。 */
export function soloChat(setup) {
  if (!setup) return freeze({ sister: false, pisces: false })
  if (setup.mode === 'pisces') return freeze({ sister: false, pisces: true })
  if (setup.mode === 'sister') return freeze({ sister: true, pisces: false })
  return freeze({ sister: true, pisces: setup.together === true })
}

/** 开场类型：solo-pisces / solo-sister / room。 */
export function welcomeKind(setup) {
  if (!setup) return null
  if (setup.mode === 'pisces') return 'solo-pisces'
  if (setup.mode === 'sister') return 'solo-sister'
  return 'room'
}

/** 只有单独派希丝的开场要存 welcome 事件；选项 2 不存；客厅 3 连不存。 */
export function welcomeStored(setup) {
  return welcomeKind(setup) === 'solo-pisces'
}

export function needsRoomWelcome(setup) {
  return Boolean(setup && setup.room && setup.roomWelcomeSent === false)
}

/** 发完客厅 3 连后置 true；没有客厅或已经 true 时原样返回。 */
export function markRoomWelcomeSent(setup) {
  if (!needsRoomWelcome(setup)) return setup
  return freeze({ ...setup, roomWelcomeSent: true })
}
