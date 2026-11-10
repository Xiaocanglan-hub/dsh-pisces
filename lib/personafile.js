// 固定段文件覆盖：`<root>/persona-fixed.md` 存在时，成年鱼的 `pisces:fixed` 整段换成它。
//
// 三条口径：
// 1. **整段替换**，不是追加、也不是卡：文件里就是她这段人设的全文，不强制任何抬头。
// 2. 只改文件、不重启：index 的 attach 包装**每轮现读**（readFixedOverride），下一轮先生效。
// 3. 写之前把旧文件复制到 `<root>/persona-fixed.bak.md`（覆盖前一份，只留一份）；
//    写入是 tmp → rename 的原子写，读失败/坏文件一律当"没有覆盖"，不抛。
import fs from 'node:fs'
import path from 'node:path'

export const FIXED_FILE = 'persona-fixed.md'
export const FIXED_BAK = 'persona-fixed.bak.md'
export const FIXED_MAX = 4000

/** 覆盖文件位置：`<root>/persona-fixed.md`。 */
export function fixedPath(root) {
  return path.join(String(root ?? ''), FIXED_FILE)
}

/** 备份文件位置：`<root>/persona-fixed.bak.md`（上一次覆盖前的正文）。 */
export function fixedBackupPath(root) {
  return path.join(String(root ?? ''), FIXED_BAK)
}

/** 去 BOM、统一换行、去掉首尾空白。空 → ''。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/**
 * 读覆盖：文件不存在 / 读不了 / 是目录 / 去空白后为空，都回 null（当没有覆盖）。
 * @returns {string|null}
 */
export function readFixedOverride(root) {
  if (!root) return null
  try {
    const text = normalize(fs.readFileSync(fixedPath(root), 'utf8'))
    return text || null
  } catch {
    return null
  }
}

/** 写之前备份旧文件；没有旧文件或复制失败都不挡这次写入。 */
function backupOld(root) {
  const file = fixedPath(root)
  try {
    if (!fs.statSync(file).isFile()) return
  } catch {
    return
  }
  try {
    fs.copyFileSync(file, fixedBackupPath(root))
  } catch {
    /* 备份失败也照写，覆盖文件本身才是这次要做的事 */
  }
}

/**
 * 写覆盖：非空、≤4000 字；原子写（tmp → rename）。
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function writeFixedOverride(root, text) {
  if (!root) return { ok: false, reason: '没有库' }
  const body = normalize(text)
  if (!body) return { ok: false, reason: '没写东西' }
  if (body.length > FIXED_MAX) return { ok: false, reason: '太长了' }

  const file = fixedPath(root)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    backupOld(root)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(tmp, `${body}\n`, 'utf8')
      fs.renameSync(tmp, file)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 没有 tmp 可清就算了 */
      }
      throw e
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `写不进去：${e?.message || e}` }
  }
}

/** 删掉覆盖文件（回到 FIXED_PERSONA）；文件本来就没有也算成功。备份不动。 */
export function clearFixedOverride(root) {
  if (!root) return { ok: false }
  try {
    fs.unlinkSync(fixedPath(root))
    return { ok: true }
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true }
    return { ok: false }
  }
}
