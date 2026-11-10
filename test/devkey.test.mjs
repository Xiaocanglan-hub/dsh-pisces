// 开发者钥匙：只存 sha256，明文只在生成/重置那一刻出现一次。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEVKEY_LEN,
  deleteDevkey,
  devkeyPath,
  ensureDevkey,
  hasDevkey,
  normalizeDevkey,
  rotateDevkey,
  verifyDevkey,
} from '../lib/devkey.js'

function mkRoot() {
  return mkdtempSync(path.join(tmpdir(), 'pisces-devkey-'))
}

test('devkey：首次 ensureDevkey 生成并只返回一次明文；第二次 created:false 不再给 key', () => {
  const root = mkRoot()
  assert.equal(hasDevkey(root), false)

  const first = ensureDevkey(root)
  assert.equal(first.created, true)
  assert.equal(typeof first.key, 'string')
  assert.equal(hasDevkey(root), true)
  assert.equal(verifyDevkey(root, first.key), true)

  const second = ensureDevkey(root)
  assert.equal(second.created, false)
  assert.equal(second.key, undefined, '第二次不该再返回明文')
})

test('devkey：16 位、去掉易混字符、展示三组；大写的字母表里没有 0/O/1/I', () => {
  const root = mkRoot()
  const { key } = ensureDevkey(root)

  const parts = key.split('-')
  assert.equal(parts.length, 3, `钥匙应该分三组：${key.length} 字符`)
  const raw = normalizeDevkey(key)
  assert.equal(raw.length, DEVKEY_LEN)
  assert.equal(raw.length, 16)
  assert.match(raw, /^[2-9A-HJ-NP-Z]+$/)
  assert.equal(/[01OI]/.test(raw), false, '字母表里不该有 0/O/1/I')
  // 规范化只抹掉 - 和空白，不改别的。
  assert.equal(normalizeDevkey(` ${key.toLowerCase()} `), raw)
})

test('devkey：verify 忽略大小写与横线，也接受不带横线的写法', () => {
  const root = mkRoot()
  const { key } = ensureDevkey(root)
  const raw = normalizeDevkey(key)

  assert.equal(verifyDevkey(root, key), true)
  assert.equal(verifyDevkey(root, raw), true)
  assert.equal(verifyDevkey(root, raw.toLowerCase()), true)
  assert.equal(verifyDevkey(root, raw.replace(/(.{5})(.{5})(.{6})/, '$1-$2-$3')), true)
})

test('devkey：错误 key / 文件不存在都是 false', () => {
  const root = mkRoot()
  assert.equal(verifyDevkey(root, 'AAAAA-BBBBB-CCCCCC'), false, '没有文件时不通过')

  const { key } = ensureDevkey(root)
  const raw = normalizeDevkey(key)
  const wrong = `${raw.slice(0, 15)}${raw[15] === '2' ? '3' : '2'}`
  assert.equal(verifyDevkey(root, wrong), false)
  assert.equal(verifyDevkey(root, ''), false)
  assert.equal(verifyDevkey(root, 'too-short'), false)
})

test('devkey：rotate 后旧 key 立刻失效，新 key 有效', () => {
  const root = mkRoot()
  const { key: oldKey } = ensureDevkey(root)
  const { key: newKey } = rotateDevkey(root)

  assert.notEqual(normalizeDevkey(newKey), normalizeDevkey(oldKey))
  assert.equal(verifyDevkey(root, oldKey), false)
  assert.equal(verifyDevkey(root, newKey), true)
})

test('devkey：hasDevkey 跟着文件走；deleteDevkey 之后变 false', () => {
  const root = mkRoot()
  assert.equal(hasDevkey(root), false)
  ensureDevkey(root)
  assert.equal(hasDevkey(root), true)
  assert.equal(deleteDevkey(root), true)
  assert.equal(hasDevkey(root), false)
  assert.equal(deleteDevkey(root), false)
})

test('devkey：文件里只有 hash/created/rev，读一遍不含明文 key', () => {
  const root = mkRoot()
  const { key } = ensureDevkey(root)
  const text = readFileSync(devkeyPath(root), 'utf8')
  const record = JSON.parse(text)
  const raw = normalizeDevkey(key)

  assert.match(record.hash, /^[0-9a-f]{64}$/)
  assert.equal(record.hash.includes(raw), false)
  assert.equal(text.includes(raw), false, '文件里不该出现明文')
  assert.equal(text.includes(key), false)
  assert.equal(typeof record.created, 'number')
  assert.equal(record.rev, 1)
})
