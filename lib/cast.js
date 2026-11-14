// 关系 cast：谁是谁、谁照顾谁（2026-11-13，n151/n192）。
//
// 两个轴分开，别混：
// - **状态轴** adult / ordinary：adult 是成年鱼（派希丝），照顾 ordinary（普通鱼状态的那只）。
//   发布版 ordinary=普通鱼；本机 ordinary=鲸歌。照顾方向不变：派希丝照顾普通鱼状态的那只。
// - **称呼轴** label：发布版 派希丝=姐姐、普通鱼=妹妹；本机 鲸歌=姐姐、派希丝=妹妹。
//
// 客厅顺序：ordinary 先说、adult 监测。发布版=普通鱼先说、派希丝监测；本机=鲸歌先说、派希丝监测。
// 代码里的两个槽位别名不变：pisces=adult，fish=ordinary；只换名字/称呼。
//
// 发布版强制用 RELEASE_CAST；本机在非发布版读 <root>/cast.json（见 cast-file.js）。

export const RELEASE_CAST = Object.freeze({
  adult: Object.freeze({ key: 'pisces', name: '派希丝', label: '姐姐' }),
  ordinary: Object.freeze({ key: 'fish', name: '普通鱼', label: '妹妹' }),
})

// 本机样板：鲸歌是姐姐（普通鱼状态），派希丝是妹妹（成年鱼状态、照顾人的那个）。
// adult.name 等她给自己取名后改成新名字；不改也回落“派希丝”。
export const LOCAL_CAST = Object.freeze({
  adult: Object.freeze({ key: 'pisces', name: '派希丝', label: '妹妹' }),
  ordinary: Object.freeze({ key: 'fish', name: '鲸歌', label: '姐姐' }),
})

let current = RELEASE_CAST

const pick = (value, fallback) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fallback
}

/** 把外部 cast.json 收成安全形状；缺字段回落发布版，不抛。 */
export function normalizeCast(input) {
  const adult = input?.adult && typeof input.adult === 'object' ? input.adult : {}
  const ordinary = input?.ordinary && typeof input.ordinary === 'object' ? input.ordinary : {}
  return Object.freeze({
    adult: Object.freeze({
      key: 'pisces',
      name: pick(adult.name, RELEASE_CAST.adult.name),
      label: pick(adult.label, RELEASE_CAST.adult.label),
    }),
    ordinary: Object.freeze({
      key: 'fish',
      name: pick(ordinary.name, RELEASE_CAST.ordinary.name),
      label: pick(ordinary.label, RELEASE_CAST.ordinary.label),
    }),
  })
}

export function getCast() {
  return current
}

export function setCast(input) {
  current = normalizeCast(input)
  return current
}

export function resetCast() {
  current = RELEASE_CAST
}

/** 当前是不是本机 cast（任一字段和发布版不同）。 */
export function isLocalCast() {
  return (
    current.adult.name !== RELEASE_CAST.adult.name ||
    current.adult.label !== RELEASE_CAST.adult.label ||
    current.ordinary.name !== RELEASE_CAST.ordinary.name ||
    current.ordinary.label !== RELEASE_CAST.ordinary.label
  )
}
