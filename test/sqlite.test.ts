/**
 * The SQLite store, on the real `node:sqlite`. Skipped on a Node without it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sqliteStore } from '../src/store/sqlite.js'
import { fakeAgent } from '../src/testing/index.js'
import type { Store } from '../src/store/types.js'
import type { Bellhop } from '../src/bellhop.js'
import { testBellhop } from './helpers.js'
import { storeConformance } from './store-conformance.js'

const sqlite = process.getBuiltinModule?.('node:sqlite')

let open: (Store | Bellhop)[] = []
let dirs: string[] = []

afterEach(async () => {
  for (const thing of open) await thing.close?.()
  open = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempFile(name: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bellhop-'))
  dirs.push(dir)
  return path.join(dir, name)
}

describe.skipIf(!sqlite)('the sqlite store', () => {
  storeConformance('sqliteStore', () => sqliteStore(':memory:'))

  it('migrates a database written by an earlier version', async () => {
    const file = tempFile('old.db')

    // The 0.2 schema: no default_printers, no per-job printer or options, no
    // handshake_complete, and printers stored as a role map.
    const db = new sqlite.DatabaseSync(file)
    db.exec(`
      create table bellhop_agents (
        id integer primary key autoincrement, remote_id integer not null, label text not null,
        token_digest text, credential text, credential_expires_at integer, claim_token_digest text,
        claim_expires_at integer, app_name text, accent_color text, agent_version text, platform text,
        capabilities text not null default '[]', printers text not null default '{}',
        last_seen_at integer, created_at integer not null
      );
      create table bellhop_jobs (
        id integer primary key autoincrement,
        agent_id integer not null references bellhop_agents(id) on delete cascade,
        kind text not null, format text not null, data text, url text, status text not null,
        error text, created_at integer not null, sent_at integer, acked_at integer
      );
      create table bellhop_sessions (
        id text primary key,
        agent_id integer not null references bellhop_agents(id) on delete cascade,
        last_polled_at integer not null
      );
      insert into bellhop_agents (remote_id, label, printers, created_at)
        values (3, 'Old Desk', '{"label":"Zebra_ZP450"}', 1);
    `)
    db.close()

    const store = sqliteStore(file)
    open.push(store)

    const agent = (await store.findAgent('1'))!
    expect(agent.label).toBe('Old Desk')
    expect(agent.printers).toEqual([])
    expect(agent.defaultPrinters).toEqual({})

    await store.createSession('s1', agent.id)
    await store.updateSession('s1', { handshakeComplete: true })
    expect((await store.findSession('s1'))!.handshakeComplete).toBe(true)

    const job = await store.createJob({
      agentId: agent.id,
      kind: 'label',
      format: 'zpl',
      printer: 'Zebra_ZP450',
      options: { copies: 3 },
      data: 'x',
      url: null,
    })
    expect((await store.findJob(job.id))!).toMatchObject({
      printer: 'Zebra_ZP450',
      options: { copies: 3 },
    })

    // Opening the same file again finds every column present and changes nothing.
    await store.close?.()
    open.splice(open.indexOf(store), 1)
    const reopened = sqliteStore(file)
    open.push(reopened)
    expect((await reopened.findAgent('1'))!.label).toBe('Old Desk')
  })

  it('serves a print round trip through Bellhop', async () => {
    const { bellhop } = testBellhop({ store: sqliteStore(':memory:') })
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })

    const job = await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    await agent.waitForPrint()

    expect(agent.printed[0]!.data!.toString()).toBe('^XA^XZ')
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')
    expect(await bellhop.agents.isOnline(agent.agentId)).toBe(true)
  })
})
