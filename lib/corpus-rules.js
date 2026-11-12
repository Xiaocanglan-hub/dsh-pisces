// 语料改写候选标记：按 DS 的 5+5 条规则，标出"长+结构"和"短+盖章"的句子。
// 只标候选，不自动改写；改写仍走 DS（n119）。
// 不用于工具回执/代码/路径/数字/表格/真步骤说明——调用方自己筛。

const STRUCTURES = [
  { name: '不是…而是', re: /不是[^。！？!?；;\n]{0,24}而是/ },
  { name: '一方面…另一方面', re: /一方面[^。！？!?；;\n]{0,24}另一方面/ },
  { name: '最…的是', re: /最[^。！？!?；;\n]{0,16}的是/ },
  { name: '先…再', re: /先[^。！？!?；;\n]{0,16}再/ },
  { name: '三连并列', re: /、[^。！？!?；;\n]{0,16}、[^。！？!?；;\n]{0,16}、/ },
  { name: '破折号', re: /——/ },
]

const RECEIPTS = ['好', '嗯', '收到', '我知道了', '我记下了', '记下了', '好嘞', '听你的', '我明白', '这条我认']
const SUMMARY = /(这是两件事|这是边界问题|这是信任问题|说到底|本质上|归根到底)$/

/** 给一句标候选原因；没有就回 []。 */
export function flagSentence(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  const base = raw.replace(/[。！？!?；;…]+$/g, '').trim()
  const len = [...base.replace(/\s+/g, '')].length
  const reasons = []

  const hits = STRUCTURES.filter(({ re }) => re.test(raw)).map((s) => s.name)
  if (len >= 20 && hits.length) reasons.push('长句+结构')
  if (hits.includes('不是…而是') || hits.includes('一方面…另一方面')) reasons.push('摆两面')
  if (hits.includes('先…再')) reasons.push('步骤腔')
  if (hits.includes('三连并列')) reasons.push('并列堆叠')
  if (SUMMARY.test(base)) reasons.push('总结收尾')
  if (len <= 8 && RECEIPTS.some((p) => base === p || base.startsWith(p))) reasons.push('短句+盖章')

  return [...new Set(reasons)]
}

/** 量一组文本里有多少候选；examples 最多 20 条。 */
export function flagCorpus(texts) {
  const list = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string' && t.trim())
  const counts = {}
  const examples = []
  let total = 0
  for (const text of list) {
    const reasons = flagSentence(text)
    if (!reasons.length) continue
    total++
    for (const r of reasons) counts[r] = (counts[r] || 0) + 1
    if (examples.length < 20) examples.push({ text: String(text), reasons })
  }
  return { total, counts, examples }
}
