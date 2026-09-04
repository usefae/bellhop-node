// Runs under plain `node --test` against the built package, imported by its
// own name, so the exports map, both module formats, and the bin are checked
// the way a consumer meets them.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const SUBPATHS = ['express', 'fastify', 'web', 'ws', 'sqlite', 'testing']

test('every entry point resolves in ESM and in CJS', async () => {
  const esm = await import('@usefae/bellhop-node')
  assert.equal(typeof esm.Bellhop, 'function')
  assert.equal(typeof require('@usefae/bellhop-node').Bellhop, 'function')
  for (const subpath of SUBPATHS) {
    assert.ok(
      Object.keys(await import(`@usefae/bellhop-node/${subpath}`)).length > 0,
      `${subpath} esm`
    )
    assert.ok(Object.keys(require(`@usefae/bellhop-node/${subpath}`)).length > 0, `${subpath} cjs`)
  }
  assert.equal(require('@usefae/bellhop-node/package.json').name, '@usefae/bellhop-node')
})

test('a class is the same object from every CJS entry point', () => {
  const { ConfigurationError, BellhopError } = require('@usefae/bellhop-node')
  const { sqliteStore } = require('@usefae/bellhop-node/sqlite')
  const original = process.getBuiltinModule
  process.getBuiltinModule = undefined // what a Node before 22.5 looks like
  try {
    assert.throws(
      () => sqliteStore(':memory:'),
      (error) =>
        error instanceof ConfigurationError &&
        error instanceof BellhopError &&
        error.code === 'unsupported_node'
    )
  } finally {
    process.getBuiltinModule = original
  }
})

test('the bin runs', () => {
  const help = spawnSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage: bellhop/)

  const version = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8' })
  assert.equal(version.status, 0)
  assert.match(version.stdout, /^bellhop \d+\.\d+\.\d+/)
})
