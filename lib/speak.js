// 说话（pisces_speak）的工具面闸：开关 → 参数 → 交给 bili.js 去发。
//
// 口径（README「说话」、知识库 n23）：
// 1. 默认关，只有 cfg.bili.speak === true 才接；
// 2. 空正文 / 超过 300 字 / bvid 形状不对，一律在本地拒掉，一个请求都不发；
// 3. 说出去收不回来，所以 reason 只写人话，不回显正文或 bvid。
import { postComment } from './bili.js'

export const SPEAK_MAX = 300

const BVID_RE = /^BV[0-9A-Za-z]{10}$/

/** 说话功能开没开：只认 cfg.bili.speak === true（'true'、1 都不算）。 */
export function speakEnabled(cfg = {}) {
  return cfg?.bili?.speak === true
}

/**
 * 本地校验。不碰网络、不读文件。
 * @returns {{ok:boolean, problems:string[]}} problems 都是能直接给人看的中文。
 */
export function validateSpeak({ bvid, text } = {}) {
  const problems = []
  const id = typeof bvid === 'string' ? bvid.trim() : ''
  const words = typeof text === 'string' ? text : ''
  if (!id) problems.push('没有 bvid')
  else if (!BVID_RE.test(id)) problems.push('bvid 不像 bvid')
  if (!words.trim()) problems.push('没话可说')
  else if (words.length > SPEAK_MAX) problems.push('太长了')
  return { ok: problems.length === 0, problems }
}

/**
 * 说一句：先判开关，再走本地校验，最后才发请求。
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function speak({ root, bvid, text, cfg = {}, fetchImpl, log } = {}) {
  if (!speakEnabled(cfg)) return { ok: false, reason: '说话功能没开' }

  const checked = validateSpeak({ bvid, text })
  if (!checked.ok) return { ok: false, reason: checked.problems[0] }

  try {
    const r = await postComment({
      root,
      bvid: String(bvid).trim(),
      text: String(text),
      cfg,
      fetchImpl,
      log,
    })
    if (r?.ok === true) return { ok: true }
    return { ok: false, reason: r?.reason || '没说成' }
  } catch {
    return { ok: false, reason: '没说成' }
  }
}
