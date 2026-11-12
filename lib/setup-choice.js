// 开局选择的后端计划：只决定「要建什么/还缺什么」，不碰宿主、不落库。
// 面板拿到 actions 后按顺序调 adopt / seed；setup.json 由调用方写。
import { createSetup } from './setup.js'

/**
 * @param {{mode?:string, together?:boolean, hasSetup?:boolean, hasSeed?:boolean, hasDemo?:boolean}} input
 * @returns {{ok:true, setup:object, actions:string[], needsPiscesBank:boolean}
 *   | {ok:false, reason:string}}
 */
export function planSetup({
  mode = 'pisces',
  together = false,
  hasSetup = false,
  hasSeed = false,
  hasDemo = false,
} = {}) {
  if (hasSetup) return { ok: false, reason: '开局已经选过了，不能改' }

  let setup
  try {
    setup = createSetup({ mode, together })
  } catch {
    return { ok: false, reason: '没有这个开局选项' }
  }

  if (mode === 'pisces') {
    return {
      ok: true,
      setup,
      actions: hasDemo ? [] : ['adopt'],
      needsPiscesBank: false,
    }
  }

  if (mode === 'sister') {
    return {
      ok: true,
      setup,
      actions: hasSeed ? [] : ['seed'],
      needsPiscesBank: false,
    }
  }

  return {
    ok: true,
    setup,
    actions: hasSeed ? [] : ['seed'],
    // 一同成长=是：还要一个派希丝库；当前先标出来，建库由后续接。
    needsPiscesBank: setup.together === true,
  }
}
