// 一次进程里跑完全部测试（不 spawn 子进程）。
//
// 收尾：测试里 72 处 mkdtemp 建出来的 pisces-* 夹具以前从不回收，两天攒了 4 万多个目录、
// 4.4 GB，落在 %TEMP% 里（见 2026-11-12 开机排查）。这里在进程退出时把本次跑出来的删掉；
// 早于本次启动的旧夹具不动（用 tools/gc-temp.mjs 单独清）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUN_START = Date.now()
const TMP_ROOT = os.tmpdir()

process.on('exit', () => {
  let removed = 0
  try {
    for (const name of fs.readdirSync(TMP_ROOT)) {
      if (!name.startsWith('pisces-')) continue
      const p = path.join(TMP_ROOT, name)
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      // 只删本次跑出来的：比启动早 5 秒以上的算旧夹具，留给 gc-temp 处理。
      if (!st.isDirectory() || st.mtimeMs < RUN_START - 5000) continue
      try {
        fs.rmSync(p, { recursive: true, force: true })
        removed++
      } catch {
        /* 被占用就跳过，不打扰测试结果 */
      }
    }
  } catch {
    /* 清理失败不影响退出码 */
  }
  if (removed) console.log(`清理本次临时夹具：${removed} 个（${TMP_ROOT}）`)
})

import './paths.test.mjs'
import './lock.test.mjs'
import './schema.test.mjs'
import './settings.test.mjs'
import './store.test.mjs'
import './derive.test.mjs'
import './affinity.test.mjs'
import './nickname.test.mjs'
import './devkey.test.mjs'
import './personafile.test.mjs'
import './guide.test.mjs'
import './reveal.test.mjs'
import './split.test.mjs'
import './search.test.mjs'
import './attrib.test.mjs'
import './reflect.test.mjs'
import './ollama.test.mjs'
import './persona.test.mjs'
import './attach.test.mjs'
import './card.test.mjs'
import './tools.test.mjs'
import './seed.test.mjs'
import './dual.test.mjs'
import './questions.test.mjs'
import './dream.test.mjs'
import './verify.test.mjs'
import './nightly.test.mjs'
import './learn.test.mjs'
import './world.test.mjs'
import './import.test.mjs'
import './export.test.mjs'
import './console.test.mjs'
import './index.test.mjs'
import './release.test.mjs'
import './client.test.mjs'
import './teach.test.mjs'
import './adopt.test.mjs'
import './persona-fixed.test.mjs'
import './bili.test.mjs'
import './qr.test.mjs'
import './biliqr.test.mjs'
import './baidu.test.mjs'
import './speak.test.mjs'
import './tool-scripts.test.mjs'
import './guard.test.mjs'
import './client-render.test.mjs'
import './home.test.mjs'
import './voice.test.mjs'
import './format.test.mjs'
import './corpus.test.mjs'
import './corpus-rules.test.mjs'
