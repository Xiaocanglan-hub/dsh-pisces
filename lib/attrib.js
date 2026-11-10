// 归因（M1）：每条她说的话，判一次"算过的（d）/ 凭感觉的（i）/ 纯描述（null）"。
// 规则先判，判不动才问本地模型；null 也是结论，会落库，所以不会每晚重问。
// 旧库里见过的 why 形状："+不过 +再 +长71"（rule）、"纯描述"、"直觉反应"（model）。

export const D_MARK = [
  '因为', '所以', '但是', '不过', '如果', '否则', '其实', '反而', '除非', '既然',
  '虽然', '尽管', '因此', '于是', '至少', '要么', '而是', '前提', '代价', '证据', '条件',
]
export const I_MARK = [
  '感觉', '觉得', '好像', '大概', '也许', '可能', '怕', '喜欢', '讨厌', '难过',
  '开心', '委屈', '舍不得', '直觉', '不想', '愿意',
]

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round2 = (v) => Math.round(v * 100) / 100

/**
 * 规则归因。decided=false 表示"规则拿不准"，交给模型。
 * @returns {{decided:boolean,label:'d'|'i'|'null',conf:number,why:string}}
 */
export function attributeByRule(ev = {}) {
  const text = String(ev.text || '')
  const t = text.replace(/\s+/g, '')
  const len = t.length
  const dHit = D_MARK.filter((w) => t.includes(w))
  const iHit = I_MARK.filter((w) => t.includes(w))
  const dScore = dHit.length * 0.25 + (len > 70 ? 0.3 : len > 40 ? 0.15 : 0)
  const iScore = iHit.length * 0.3 + (len < 18 ? 0.2 : 0) + (/[！!？?]/.test(t) ? 0.05 : 0)

  if (dScore >= 0.5 && dScore >= iScore) {
    return { decided: true, label: 'd', conf: round2(clamp(0.55 + dScore, 0, 0.95)), why: `+${dHit.join(' +')}${len > 70 ? ` +长${len}` : ''}` }
  }
  if (iScore >= 0.5 && iScore > dScore) {
    return { decided: true, label: 'i', conf: round2(clamp(0.5 + iScore, 0, 0.9)), why: `+${iHit.join(' +')}${len < 18 ? ` 短${len}` : ''}` }
  }
  if (len <= 16 && !dHit.length && !iHit.length) {
    return { decided: true, label: 'null', conf: 0.6, why: '纯描述' }
  }
  return { decided: false, label: 'null', conf: 0, why: `拿不准（长${len}）` }
}

/** 给模型的提示：只回一个 JSON，不要解释。 */
export function attributePrompt(ev) {
  return [
    '你在判断一句话是"算过的"还是"凭感觉的"。只回一段 JSON，不要解释。',
    '{"label":"d|i|null","why":"不超过 12 字"}',
    '',
    'd：先算再开口——讲条件、因果、代价、比较、边界，能说清"为什么"。',
    'i：凭感觉——情绪、直觉、身体反应、直接的好恶，说不清理由。',
    'null：只是描述事实，没有判断，也没有立场。',
    '',
    `那句话：${String(ev?.text || '')}`,
  ].join('\n')
}

/** 宽容地解析模型输出：优先 JSON，其次找独立的 d/i/null。 */
export function parseLabel(raw) {
  const s = String(raw || '').trim()
  try {
    const j = JSON.parse(s)
    if (j && ['d', 'i', 'null'].includes(String(j.label))) {
      return { label: String(j.label), why: String(j.why || '').slice(0, 20), conf: Number(j.conf) || 0.75 }
    }
  } catch {}
  const m = /(?:^|[^a-z])(d|i|null)(?:[^a-z]|$)/i.exec(s)
  if (m) return { label: m[1].toLowerCase(), why: '', conf: 0.7 }
  if (/算过|理性|条件|因果/.test(s)) return { label: 'd', why: '模型说算过的', conf: 0.7 }
  if (/感觉|直觉|情绪/.test(s)) return { label: 'i', why: '模型说凭感觉', conf: 0.7 }
  return { label: 'null', why: '模型没给清楚', conf: 0.5 }
}
