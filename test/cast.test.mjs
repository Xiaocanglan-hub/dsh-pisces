import test from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_CAST, getCast, resetCast, setCast } from '../lib/cast.js'
import { relationLines } from '../lib/relation.js'
import { composeRoom, monitorVerdict, parseMentions, splitRoom } from '../lib/room.js'
import { runRoom } from '../lib/room-run.js'

const user = (content) => [{ role: 'user', content }]

test('cast：默认发布关系', () => {
  resetCast()
  assert.equal(getCast().adult.name, '派希丝')
  assert.equal(getCast().ordinary.name, '普通鱼')
  assert.match(relationLines({ demo: true }), /你是姐姐/)
  assert.match(relationLines({ demo: false }), /派希丝是你姐姐/)
})

test('cast：本机称呼翻过来，照顾方向不变（派希丝照顾鲸歌）', () => {
  setCast(LOCAL_CAST)
  try {
    assert.match(relationLines({ demo: true }), /你是妹妹，鲸歌是你姐姐/)
    assert.match(relationLines({ demo: false }), /派希丝是你妹妹，你是她姐姐/)
    assert.match(relationLines({ demo: true }), /我是妹妹，不是女儿/)
  } finally {
    resetCast()
  }
})

test('cast：本机点名按称呼走', () => {
  setCast(LOCAL_CAST)
  try {
    assert.deepEqual(parseMentions('姐姐，你来说'), { pisces: false, fish: true })
    assert.deepEqual(parseMentions('妹妹，你来说'), { pisces: true, fish: false })
    assert.deepEqual(parseMentions('鲸歌，你来说'), { pisces: false, fish: true })
    assert.deepEqual(parseMentions('派希丝，你说'), { pisces: true, fish: false })
    assert.equal(composeRoom({ fish: '一。', pisces: '二。' }), '【鲸歌】一。\n\n【派希丝】二。')
    assert.deepEqual(splitRoom('【鲸歌】一。\n【派希丝】二。'), { fish: '一。', pisces: '二。' })
    assert.equal(monitorVerdict('@鲸歌 你来说。').callFish, true)
  } finally {
    resetCast()
  }
})

test('cast：本机客厅鲸歌先说、派希丝监测', async () => {
  setCast(LOCAL_CAST)
  try {
    const seen = []
    const call = async (system) => {
      seen.push(system)
      return seen.length === 1 ? '我听着。' : '先坐下。'
    }
    const r = await runRoom({ messages: user('今天有点累'), call, piscesSystem: 'P', fishSystem: 'F' })
    assert.equal(r.text, '【鲸歌】我听着。\n\n【派希丝】先坐下。')
    assert.match(seen[0], /只回一句/)
    assert.match(seen[1], /你是派希丝/)
    assert.match(seen[1], /@鲸歌/)
  } finally {
    resetCast()
  }
})
