// 归因跑批：规则先判，判不动才问本地模型，最多问 40 条。
// 只写 index.db 的 attrib 表（不进事件流）。已经判过的 seq 不再重问——null 也算判过。
import { attributeByRule, attributePrompt, parseLabel } from './attrib.js'

export const CANDIDATE_TYPES = ['utterance', 'refusal', 'revise', 'answer']

/**
 * @returns {{candidates,ruled,modeled,nulls,failed,skippedTotal,labeled,modelCalls,written,rows?,remaining}}
 */
export async function attributePending({ store, model = null, maxModelCalls = 40, log = () => {}, now = Date.now(), dryRun = false } = {}) {
  const events = store.readAll()
  const done = new Set((store.attribAll?.() || []).map((r) => Number(r.seq)))
  const pool = events.filter((e) => CANDIDATE_TYPES.includes(e.type) && !done.has(Number(e.seq)))

  const stats = {
    candidates: pool.length,
    ruled: 0,
    modeled: 0,
    modelCalls: 0,
    nulls: 0,
    failed: 0,
    skippedTotal: done.size,
    labeled: { d: 0, i: 0 },
  }
  const rows = []
  const take = (ev, r) => {
    rows.push({ seq: Number(ev.seq), day: ev.day, label: r.label, conf: r.conf, why: r.why, by: r.by || 'rule', model: r.model || '', at: now })
    if (r.label === 'null') stats.nulls += 1
    else stats.labeled[r.label] += 1
  }

  for (const ev of pool) {
    const rule = attributeByRule(ev)
    if (rule.decided) {
      take(ev, rule)
      stats.ruled += 1
      continue
    }
    if (!model || stats.modelCalls >= maxModelCalls) {
      take(ev, { label: 'null', conf: 0.5, why: model ? '模型次数用完了' : '没有模型', by: 'rule' })
      stats.ruled += 1
      continue
    }
    try {
      const out = await model.ask(attributePrompt(ev))
      stats.modelCalls += 1
      const parsed = parseLabel(out)
      take(ev, { ...parsed, by: 'model', model: model.name || 'local' })
      stats.modeled += 1
    } catch (e) {
      stats.failed += 1
      log?.('归因问模型失败：', e?.message || e)
      take(ev, { label: 'null', conf: 0.5, why: '模型没答上来', by: 'rule' })
    }
  }

  if (!dryRun && rows.length) store.attribPut?.(rows)
  return {
    ...stats,
    written: dryRun ? 0 : rows.length,
    remaining: 0,
    ...(dryRun ? { rows } : {}),
  }
}

export const reflect = attributePending
