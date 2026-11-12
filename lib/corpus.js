// 语料测量：把"像不像人"折成可比的数。纯函数，不读文件、不写库。
// 六个量：句长 CV / ≤6 字句比例 / 语气词密度 / 盖章句密度 / 结构句式密度 / 同窗口扎堆。
// 只量输出样本，不量固定段/guard；数字只用于比较，不进提示词。

const SENTENCE_SPLIT = /[。！？!?；;\n]+/
const PARTICLES = new Set([...'嗯啊吧呢呀啦嘛欸唉哦噢喔诶哎哈嘿'])
const RECEIPTS = ['我记下了', '记住了', '这条我认', '接得漂亮', '我收下了', '我知道了', '我明白了', '收到', '好嘞', '记下了']
const STRUCTURES = [
  { name: '不是…而是', re: /不是[^。！？!?；;\n]{0,24}而是/ },
  { name: '最…的是', re: /最[^。！？!?；;\n]{0,16}的是/ },
  { name: '先…再', re: /先[^。！？!?；;\n]{0,16}再/ },
  { name: '三连并列', re: /、[^。！？!?；;\n]{0,16}、[^。！？!?；;\n]{0,16}、/ },
  { name: '破折号', re: /——/ },
  { name: '一方面…另一方面', re: /一方面[^。！？!?；;\n]{0,24}另一方面/ },
]

const round2 = (v) => Math.round(v * 100) / 100
const round3 = (v) => Math.round(v * 1000) / 1000

/** 按句号/问号/叹号/分号/换行切句；去掉空白，空句丢掉。 */
export function sentences(text) {
  return String(text ?? '')
    .split(SENTENCE_SPLIT)
    .map((s) => s.replace(/\s+/g, '').trim())
    .filter(Boolean)
}

function occurrences(haystack, needle) {
  if (!needle) return 0
  return haystack.split(needle).length - 1
}

/**
 * 量一组文本。
 * @param {string[]} texts
 * @returns {{n:number, chars:number, sentences:number, meanLen:number, cv:number, shortPct:number, particlePer1k:number, receiptPer1k:number, structurePer1k:number, cluster2Pct:number, cluster3Pct:number}}
 */
export function measure(texts) {
  const list = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string' && t.trim())
  let chars = 0
  let sents = 0
  let short = 0
  let particles = 0
  let receipts = 0
  let structures = 0
  let windows = 0
  let cluster2 = 0
  let cluster3 = 0
  const lengths = []

  for (const text of list) {
    const clean = String(text).replace(/\s+/g, '')
    chars += [...clean].length

    const ss = sentences(text)
    sents += ss.length
    for (const s of ss) {
      const n = [...s].length
      lengths.push(n)
      if (n <= 6) short++
    }

    for (const ch of clean) if (PARTICLES.has(ch)) particles++
    for (const p of RECEIPTS) receipts += occurrences(clean, p)
    for (const { re } of STRUCTURES) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
      structures += (clean.match(g) || []).length
    }

    const cps = [...clean]
    for (let i = 0; i < cps.length; i += 100) {
      const win = cps.slice(i, i + 100).join('')
      const hit = STRUCTURES.filter(({ re }) => re.test(win)).length
      windows++
      if (hit >= 2) cluster2++
      if (hit >= 3) cluster3++
    }
  }

  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  const variance = lengths.length ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length : 0
  const std = Math.sqrt(variance)
  const cv = mean > 0 ? std / mean : 0

  return {
    n: list.length,
    chars,
    sentences: sents,
    meanLen: round2(mean),
    cv: round3(cv),
    shortPct: sents ? round2((short / sents) * 100) : 0,
    particlePer1k: chars ? round2((particles / chars) * 1000) : 0,
    receiptPer1k: chars ? round2((receipts / chars) * 1000) : 0,
    structurePer1k: chars ? round2((structures / chars) * 1000) : 0,
    cluster2Pct: windows ? round2((cluster2 / windows) * 100) : 0,
    cluster3Pct: windows ? round2((cluster3 / windows) * 100) : 0,
  }
}
