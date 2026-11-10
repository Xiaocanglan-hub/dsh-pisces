// 本地模型（ollama）。默认不自动拉起服务：调不通就当作"没有模型"。
// 只做一件事：给一段提示词，拿回文本。归因、梦、卡复审都用它。
export const DEFAULT_OLLAMA = 'http://127.0.0.1:11434'
export const DEFAULT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M'

export function createLocalModel({
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_OLLAMA,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch,
  numPredict = 160,
} = {}) {
  async function ask(prompt, { signal, temperature = 0.2, maxTokens } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: String(prompt || '') }],
          stream: false,
          options: { num_predict: Number(maxTokens ?? numPredict), temperature },
        }),
        signal: signal || ctrl.signal,
      })
      if (!res.ok) throw new Error(`ollama ${res.status}`)
      const j = await res.json()
      return String(j?.message?.content ?? j?.response ?? '')
    } finally {
      clearTimeout(timer)
    }
  }
  return { name: model, baseUrl, ask }
}

/** 探一下本地有没有这个模型：没有就返回 null，不抛。 */
export async function probeLocalModel(opts = {}) {
  const m = createLocalModel({ ...opts, timeoutMs: opts.timeoutMs ?? 3_000 })
  try {
    const out = await m.ask('只回答：收到', { maxTokens: 8 })
    return { ok: true, model: m.name, reply: String(out).slice(0, 20) }
  } catch (e) {
    return { ok: false, model: m.name, reason: e?.message || String(e) }
  }
}
