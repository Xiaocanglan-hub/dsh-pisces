// wonder：她自己想起来一句"世界类"的问题（自学的前置）。全部注入假模型/假网络，不连真网。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore } from '../lib/store.js'
import { LEARN_ENDPOINT, learn } from '../lib/learn.js'
import { usableWonder, wonder, WONDER_GAP_MS, WONDER_LAST_KEY } from '../lib/wonder.js'

const NOW = Date.parse('2026-11-15T03:00:00+08:00')

async function mkStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'pisces-wonder-'))
  return createStore({ root, forceJsonl: true })
}

function fakeModel(reply) {
  let calls = 0
  return {
    name: 'fake-wonder',
    get calls() {
      return calls
    },
    async ask() {
      calls += 1
      return typeof reply === 'function' ? reply() : reply
    },
  }
}

test('usableWonder：只收一句关于世界的中文疑问句', () => {
  assert.equal(usableWonder('猫为什么会在人的腿上睡觉？'), '猫为什么会在人的腿上睡觉？')
  assert.equal(usableWonder('「潮水一天涨几次？」'), '潮水一天涨几次？', '去掉引号')
  assert.equal(usableWonder('1. 月亮为什么跟着人走？'), '月亮为什么跟着人走？', '去掉编号')
  assert.equal(usableWonder('你觉得猫为什么会踩奶？'), null, '问人的不算')
  assert.equal(usableWonder('他为什么会那样？'), null, '问他人的不算')
  assert.equal(usableWonder('猫会在人的腿上睡觉。'), null, '不是问句')
  assert.equal(usableWonder('猫？'), null, '太短')
  assert.equal(usableWonder('），。'), null)
  assert.equal(usableWonder(''), null)
})

test('wonder：没有模型就不编问题', async () => {
  const store = await mkStore()
  const r = await wonder({ store, model: null, now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '没有模型')
  assert.equal(store.kvAll ? Object.keys(store.kvAll()).length : 0, 0, '没模型不落任何状态')
  store.close()
})

test('wonder：模型给的不是问题就不落库，也不推进节奏', async () => {
  const store = await mkStore()
  const r = await wonder({ store, model: fakeModel('你最近怎么样？'), now: NOW })
  assert.equal(r.ok, false)
  assert.equal(r.reason, '没想出能问的问题')
  assert.equal(store.modeGet(WONDER_LAST_KEY), null, '失败不写 last')
  store.close()
})

test('wonder：问到一句就落进问题表（kind=about / source=wonder），七天内不再问', async () => {
  const store = await mkStore()
  const model = fakeModel('潮水一天涨几次？')
  const first = await wonder({ store, model, now: NOW })
  assert.equal(first.ok, true)
  assert.equal(first.question, '潮水一天涨几次？')
  assert.equal(model.calls, 1)

  const rows = store.questionAll ? store.questionAll() : []
  const saved = (Array.isArray(rows) ? rows : []).find((q) => q.text === '潮水一天涨几次？')
  assert.ok(saved, '问题要进表')
  assert.equal(saved.kind, 'about')
  assert.equal(saved.source, 'wonder')
  assert.equal(saved.status, 'open')

  const again = await wonder({ store, model, now: NOW + 24 * 3600 * 1000 })
  assert.equal(again.ok, false)
  assert.equal(again.skipped, true, '七天内不再问')
  assert.equal(model.calls, 1, '跳过时不该再调模型')

  const later = await wonder({ store, model: fakeModel('月亮为什么跟着人走？'), now: NOW + WONDER_GAP_MS + 1 })
  assert.equal(later.ok, true, '过了间隔可以再问一句')
  store.close()
})

test('wonder 造的问题会被 learn 当成"可查的"拿去搜（kind 对齐）', async () => {
  const store = await mkStore()
  await wonder({ store, model: fakeModel('猫为什么会在人的腿上睡觉？'), now: NOW })

  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    if (String(url).startsWith(LEARN_ENDPOINT)) {
      const pageUrl = 'https://example.com/cat'
      return {
        ok: true,
        status: 200,
        async text() {
          return `<ol><li class="b_algo"><h2><a href="${pageUrl}">猫为什么在腿上睡觉</a></h2><p class="b_lineclamp2"></p></li></ol>`
        },
      }
    }
    return { ok: true, status: 200, async text() { return '<p>猫在人的腿上睡觉，是因为那里暖，也能让它觉得安全。猫喜欢待在有体温的地方。</p>' } }
  }
  const r = await learn({ store, fetchImpl, now: NOW + 1000, maxQuestions: 1 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.studied.length, 1)
  assert.equal(r.studied[0].question, '猫为什么会在人的腿上睡觉？')
  assert.ok(seen.some((u) => u.startsWith(LEARN_ENDPOINT)), '要真的去搜')
  store.close()
})
