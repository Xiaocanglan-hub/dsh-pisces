// 事件的形状与上限。所有写入都要先过这里，形状不对就不落库。
// 类型分三层：她自己说的（HER）、系统记的（SYS）、复盘长出来的（GROWTH）。

export const HER_TYPES = ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'dream']

export const SYS_TYPES = ['seed', 'answer', 'test', 'absence', 'meta', 'diary', 'voice', 'heard', 'ask', 'grant_offer', 'grant', 'welcome', 'teaching', 'room']

export const GROWTH_TYPES = ['split', 'mode_shift', 'card_patch', 'dream_sim', 'question']

export const ALL_TYPES = [...HER_TYPES, ...SYS_TYPES, ...GROWTH_TYPES]

// agent：她本人在流里生成、由 attach 自动落库的 utterance（source:'agent'）。
export const SOURCES = ['tool', 'system', 'owner', 'agent', 'migration']

export const MAX_TEXT = 2000
export const MAX_REFS = 16

/** 校验一条待写入的事件。refs 里允许放别家的 id（B 站 BV 号），所以不校验格式。 */
export function validateEvent(input = {}) {
  const problems = []
  const type = String(input.type ?? '').trim()
  if (!ALL_TYPES.includes(type)) problems.push(`未知类型：${type || '(空)'}`)

  const text = String(input.text ?? '')
  if (!text.trim()) problems.push('正文不能为空')
  if (text.length > MAX_TEXT) problems.push(`正文太长：${text.length} > ${MAX_TEXT}`)

  const refs = input.refs ?? []
  if (!Array.isArray(refs)) problems.push('refs 必须是数组')
  else if (refs.length > MAX_REFS) problems.push(`refs 太多：${refs.length} > ${MAX_REFS}`)

  const source = String(input.source ?? 'system')
  if (!SOURCES.includes(source)) problems.push(`未知 source：${source}`)

  const meta = input.meta ?? {}
  if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) problems.push('meta 必须是对象')

  return problems.length ? { ok: false, problems } : { ok: true, problems: [] }
}
