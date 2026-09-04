import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli-main.js'
import { sqliteStore } from '../src/store/sqlite.js'
import { fakeLicensing } from '../src/testing/licensing.js'

const sqlite = process.getBuiltinModule?.('node:sqlite')

const ENV = {
  BELLHOP_SECRET_KEY: 'bh_sk_test',
  BELLHOP_PUBLIC_URL: 'http://localhost:4000',
  BELLHOP_API_URL: 'https://bellhop.test',
}

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function run(argv: string[], env: NodeJS.ProcessEnv = {}, fetch = fakeLicensing().fetch) {
  const out: string[] = []
  const err: string[] = []
  const code = await main(
    argv,
    env,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { fetch, colour: false }
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('the bellhop command', () => {
  it('prints usage on --help and exits 0, and exits 1 with no command', async () => {
    const help = await run(['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: bellhop')

    const bare = await run([])
    expect(bare.code).toBe(1)
    expect(bare.err).toContain('Usage: bellhop')
  })

  it('prints the package version on --version', async () => {
    const result = await run(['--version'])
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/^bellhop \d+\.\d+\.\d+/)
  })

  it('rejects an unknown option without a stack trace', async () => {
    const result = await run(['--bogus'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('--bogus')
  })

  it('needs a secret key', async () => {
    const result = await run(['doctor'])
    expect(result.code).toBe(1)
    expect(result.err).toContain('BELLHOP_SECRET_KEY')
  })

  it('doctor reports the environment and leaves out store lines without a database', async () => {
    const result = await run(['doctor'], ENV)
    expect(result.code).toBe(0)
    expect(result.out).toContain('authenticated as "Test App"')
    expect(result.out).toContain('pairing host is localhost:4000')
    expect(result.out).toMatch(/✓ webhook/)
    expect(result.out).not.toMatch(/✓ agents/)
    expect(result.out).not.toMatch(/✓ credentials/)
    expect(result.out).toContain('--db')
  })

  it('pair refuses to mint a link no server could honour', async () => {
    const licensing = fakeLicensing()
    const result = await run(['pair', 'Desk'], ENV, licensing.fetch)
    expect(result.code).toBe(1)
    expect(result.err).toContain('--db')
    // No slot was taken on the plan.
    expect(licensing.state.remoteAgents).toHaveLength(0)
  })

  it('agents lists what bellhop.dev knows', async () => {
    const licensing = fakeLicensing()
    licensing.state.remoteAgents.push({ id: 7, label: 'Front Desk', status: 'active' })
    const result = await run(['agents'], ENV, licensing.fetch)
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/7\s+active\s+Front Desk/)
  })

  it('explains a licensing failure and exits 1', async () => {
    const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'))
    const result = await run(['agents'], ENV, unreachable)
    expect(result.code).toBe(1)
    expect(result.err).toContain('unreachable')
  })

  describe.skipIf(!sqlite)('with --db', () => {
    it('pair mints a link into that database, and doctor reports its agents', async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'bellhop-cli-'))
      dirs.push(dir)
      const db = path.join(dir, 'bellhop.db')
      const licensing = fakeLicensing()

      const paired = await run(['pair', 'Desk', '--db', db], ENV, licensing.fetch)
      expect(paired.code).toBe(0)
      expect(paired.out).toContain('bellhop://pair?server=')
      expect(licensing.state.remoteAgents).toHaveLength(1)

      const store = sqliteStore(db)
      const agents = await store.listAgents()
      await store.close?.()
      expect(agents).toHaveLength(1)
      expect(agents[0]!.claimTokenDigest).not.toBeNull()

      const doctor = await run(['doctor'], { ...ENV, BELLHOP_DB: db }, licensing.fetch)
      expect(doctor.code).toBe(0)
      expect(doctor.out).toMatch(/✓ agents\s+1 known/)
      expect(doctor.out).toContain(db)
    })
  })
})
