import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveRoot, pointerPath, paths, ensureDirs, writePointer } from '../lib/paths.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'pisces-paths-'))

test('paths：环境变量优先，其次指针文件，最后默认目录', () => {
  const home = tmp()
  const env = { USERPROFILE: home }
  assert.equal(resolveRoot(env), path.join(home, '.dsh-pisces'))

  writePointer(path.join(home, 'another'), env)
  assert.equal(resolveRoot(env), path.join(home, 'another'))

  const withEnv = { ...env, DSH_PISCES_HOME: path.join(home, 'explicit') }
  assert.equal(resolveRoot(withEnv), path.join(home, 'explicit'))
  assert.ok(pointerPath(env).endsWith('.dsh-pisces-location.json'))
})

test('paths：指针文件坏了也不炸，退回默认', () => {
  const home = tmp()
  writeFileSync(path.join(home, '.dsh-pisces-location.json'), '{ not json', 'utf8')
  assert.equal(resolveRoot({ USERPROFILE: home }), path.join(home, '.dsh-pisces'))
})

test('paths：ensureDirs 建出根、diary、backup，路径都在根下', () => {
  const root = path.join(tmp(), 'data')
  const p = ensureDirs(root)
  assert.equal(p.root, path.resolve(root))
  assert.equal(p.events, path.join(p.root, 'events.db'))
  assert.equal(p.index, path.join(p.root, 'index.db'))
  assert.equal(p.world, path.join(p.root, 'world.db'))
  assert.ok(path.isAbsolute(p.diaryDir) && path.isAbsolute(p.backupDir))
  assert.ok(paths(root).lockFile.endsWith('lock.json'))
})
