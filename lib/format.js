// 格式审计：只数字面痕迹（标题 / 编号 / 粗体 / 列表 / 表格 / 代码围栏），
// 不判断"该不该分条"——判断权留给人。
//
// 代码围栏单列、不计入 total：她贴代码时，代码块是合法的。
// 与 dsh-fish-tone 的保护区同向：代码、路径、数字、表格不碰。

const HEADING = /^\s{0,3}#{1,6}\s+/
const NUMBERED = /^\s{0,3}\d{1,3}[.、)]\s+/
const BULLET = /^\s{0,3}[-*+]\s+/
const FENCE = /^\s{0,3}```/
const BOLD = /\*\*[^*\n]+\*\*/g
const TABLE_SEP = /^[\s|:-]+$/

/** 表格分隔行：含 |、含 ---、且只有空白/|/:/ -。 */
function isTableSep(line) {
  return /\|/.test(line) && /-{3,}/.test(line) && TABLE_SEP.test(line)
}

/**
 * 数字面格式痕迹。纯函数：同一段文字永远同一个结果。
 * @param {unknown} text
 * @returns {{headings:number, numbered:number, bullets:number, bold:number, tables:number, fences:number, total:number}}
 *   total 不含 fences；table 按"表头 + 分隔行"计 1。
 */
export function auditFormat(text) {
  const s = typeof text === 'string' ? text : ''
  const lines = s.split(/\r?\n/)
  let headings = 0
  let numbered = 0
  let bullets = 0
  let tables = 0
  let fences = 0
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      fences++
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (HEADING.test(line)) headings++
    else if (NUMBERED.test(line)) numbered++
    else if (BULLET.test(line)) bullets++
    if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) tables++
  }

  const bold = (s.match(BOLD) || []).length
  return {
    headings,
    numbered,
    bullets,
    bold,
    tables,
    fences,
    total: headings + numbered + bullets + bold + tables,
  }
}
