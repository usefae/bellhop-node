/**
 * A durable store over the built-in `node:sqlite`, so there is nothing to
 * install. Needs Node 22.5 or newer. On anything older, or without a writable
 * disk, use `memoryStore()` in development and implement `Store` over your
 * real database in production.
 *
 *   import { sqliteStore } from '@usefae/bellhop-node/sqlite'
 *   const bellhop = new Bellhop({ ..., store: sqliteStore('bellhop.db') })
 */

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { ConfigurationError } from '../errors.js'
import type { JobPatch, JobRecord, SessionRecord, AgentPatch, AgentRecord, Store } from './types.js'
import type { Capability, Printer, PrintFormat, PrintOptions, ServerMessage } from '../types.js'

/** Rows come back as SQLite's own scalar types. */
type Row = Record<string, SQLOutputValue>

const text = (value: SQLOutputValue | undefined): string | null =>
  value == null ? null : String(value)
const num = (value: SQLOutputValue | undefined): number | null =>
  value == null ? null : Number(value)
const json = (value: SQLOutputValue | undefined, fallback: string): unknown =>
  JSON.parse(value == null ? fallback : String(value))

/** A row written before printers became an array reads as an empty inventory. */
const inventory = (value: SQLOutputValue | undefined): Printer[] => {
  const parsed = json(value, '[]')
  return Array.isArray(parsed) ? (parsed as Printer[]) : []
}

/**
 * `node:sqlite` arrived in Node 22.5 and this package supports 20.11, so it
 * is looked up here rather than imported. An older Node then gets a message
 * that says what to do, instead of "unknown builtin module".
 */
function loadSqlite(): typeof import('node:sqlite') {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) {
    throw new ConfigurationError(
      `sqliteStore needs Node 22.5 or later; this is Node ${process.versions.node}. Use memoryStore() in development, or implement Store over your own database.`,
      'unsupported_node'
    )
  }
  return sqlite
}

export function sqliteStore(filename = 'bellhop.db'): Store {
  const { DatabaseSync } = loadSqlite()
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
  }

  const db = new DatabaseSync(filename)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  // Two processes on one file (TRANSPORTS.md §2.4) would otherwise see
  // SQLITE_BUSY the moment their writes overlap.
  db.exec('pragma busy_timeout = 5000')
  db.exec(`
    create table if not exists bellhop_agents (
      id                    integer primary key autoincrement,
      remote_id             integer not null,
      label                 text not null,
      token_digest          text,
      credential            text,
      credential_expires_at integer,
      claim_token_digest    text,
      claim_expires_at      integer,
      app_name              text,
      accent_color          text,
      agent_version         text,
      platform              text,
      capabilities          text not null default '[]',
      printers              text not null default '[]',
      default_printers      text not null default '{}',
      last_seen_at          integer,
      created_at            integer not null
    );

    -- autoincrement, not a plain rowid: SQLite reuses the highest rowid after
    -- a delete, and a job id must never be reused (PROTOCOL.md §8).
    create table if not exists bellhop_jobs (
      id         integer primary key autoincrement,
      agent_id integer not null references bellhop_agents(id) on delete cascade,
      kind       text not null,
      format     text not null,
      printer    text,
      options    text,
      data       text,
      url        text,
      status     text not null,
      error      text,
      created_at integer not null,
      sent_at    integer,
      acked_at   integer
    );

    create table if not exists bellhop_sessions (
      id                 text primary key,
      agent_id           integer not null references bellhop_agents(id) on delete cascade,
      handshake_complete integer not null default 0,
      last_polled_at     integer not null
    );

    -- The session's queue. In the database so any process can write to it and
    -- any process can serve a poll from it (TRANSPORTS.md §2.4).
    create table if not exists bellhop_session_messages (
      id         integer primary key autoincrement,
      session_id text not null references bellhop_sessions(id) on delete cascade,
      message    text not null
    );

    create index if not exists bellhop_jobs_agent_status on bellhop_jobs (agent_id, status);
    create index if not exists bellhop_agents_token on bellhop_agents (token_digest);
    create index if not exists bellhop_agents_claim on bellhop_agents (claim_token_digest);
    create index if not exists bellhop_sessions_agent on bellhop_sessions (agent_id, last_polled_at);
    create index if not exists bellhop_session_messages_session on bellhop_session_messages (session_id);
  `)

  // Columns added since the first release, applied only where missing. A
  // failure here is a real one (a read-only file, a full disk) and surfaces
  // now rather than as a baffling error on the first query.
  const migrations: [table: string, column: string, ddl: string][] = [
    [
      'bellhop_sessions',
      'handshake_complete',
      'alter table bellhop_sessions add column handshake_complete integer not null default 0',
    ],
    [
      'bellhop_agents',
      'default_printers',
      "alter table bellhop_agents add column default_printers text not null default '{}'",
    ],
    ['bellhop_jobs', 'printer', 'alter table bellhop_jobs add column printer text'],
    ['bellhop_jobs', 'options', 'alter table bellhop_jobs add column options text'],
  ]
  const hasColumn = db.prepare('select 1 from pragma_table_info(?) where name = ?')
  for (const [table, column, ddl] of migrations) {
    if (!hasColumn.get(table, column)) db.exec(ddl)
  }
  // `printers` changed shape without a migration: an old role map reads as an
  // empty inventory, and the next `hello` replaces it.

  const one = (sql: string, ...params: SQLInputValue[]): Row | undefined =>
    db.prepare(sql).get(...params)

  const all = (sql: string, ...params: SQLInputValue[]): Row[] => db.prepare(sql).all(...params)

  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)

  const toAgent = (row: Row | undefined): AgentRecord | null =>
    row
      ? {
          id: String(row.id),
          remoteId: Number(row.remote_id),
          label: String(row.label),
          tokenDigest: text(row.token_digest),
          credential: text(row.credential),
          credentialExpiresAt: num(row.credential_expires_at),
          claimTokenDigest: text(row.claim_token_digest),
          claimExpiresAt: num(row.claim_expires_at),
          appName: text(row.app_name),
          accentColor: text(row.accent_color),
          agentVersion: text(row.agent_version),
          platform: text(row.platform),
          capabilities: json(row.capabilities, '[]') as Capability[],
          printers: inventory(row.printers),
          defaultPrinters: json(row.default_printers, '{}') as Record<string, string>,
          lastSeenAt: num(row.last_seen_at),
          createdAt: Number(row.created_at),
        }
      : null

  const toJob = (row: Row | undefined): JobRecord | null =>
    row
      ? {
          id: String(row.id),
          agentId: String(row.agent_id),
          kind: String(row.kind),
          format: String(row.format) as PrintFormat,
          printer: text(row.printer),
          options: row.options == null ? null : (json(row.options, 'null') as PrintOptions),
          data: text(row.data),
          url: text(row.url),
          status: String(row.status) as JobRecord['status'],
          error: text(row.error),
          createdAt: Number(row.created_at),
          sentAt: num(row.sent_at),
          ackedAt: num(row.acked_at),
        }
      : null

  const toSession = (row: Row | undefined): SessionRecord | null =>
    row
      ? {
          id: String(row.id),
          agentId: String(row.agent_id),
          handshakeComplete: Boolean(row.handshake_complete),
          lastPolledAt: Number(row.last_polled_at),
        }
      : null

  // Patches: an absent key leaves the stored value alone, an explicit null
  // clears it.
  const AGENT_COLUMNS: Record<keyof AgentPatch, string> = {
    remoteId: 'remote_id',
    label: 'label',
    tokenDigest: 'token_digest',
    credential: 'credential',
    credentialExpiresAt: 'credential_expires_at',
    claimTokenDigest: 'claim_token_digest',
    claimExpiresAt: 'claim_expires_at',
    appName: 'app_name',
    accentColor: 'accent_color',
    agentVersion: 'agent_version',
    platform: 'platform',
    capabilities: 'capabilities',
    printers: 'printers',
    defaultPrinters: 'default_printers',
    lastSeenAt: 'last_seen_at',
  }

  const JOB_COLUMNS: Record<keyof JobPatch, string> = {
    kind: 'kind',
    format: 'format',
    printer: 'printer',
    options: 'options',
    data: 'data',
    url: 'url',
    status: 'status',
    error: 'error',
    sentAt: 'sent_at',
    ackedAt: 'acked_at',
  }

  const JSON_KEYS = new Set(['capabilities', 'printers', 'defaultPrinters', 'options'])

  function applyPatch(
    table: string,
    columns: Record<string, string>,
    id: string,
    patch: Record<string, unknown>
  ): void {
    const sets: string[] = []
    const values: SQLInputValue[] = []
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key]
      if (!column || value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(JSON_KEYS.has(key) ? JSON.stringify(value) : (value as SQLInputValue))
    }
    if (sets.length === 0) return
    values.push(Number(id))
    run(`update ${table} set ${sets.join(', ')} where id = ?`, ...values)
  }

  const store: Store = {
    async createAgent(input) {
      const result = run(
        `insert into bellhop_agents (remote_id, label, claim_token_digest, claim_expires_at, created_at)
         values (?, ?, ?, ?, ?)`,
        input.remoteId,
        input.label,
        input.claimTokenDigest,
        input.claimExpiresAt,
        Date.now()
      )
      return toAgent(
        one('select * from bellhop_agents where id = ?', Number(result.lastInsertRowid))
      )!
    },

    async findAgent(id) {
      return toAgent(one('select * from bellhop_agents where id = ?', Number(id)))
    },

    async findAgentByTokenDigest(digest) {
      return toAgent(one('select * from bellhop_agents where token_digest = ?', digest))
    },

    async findAgentByClaimDigest(digest) {
      return toAgent(one('select * from bellhop_agents where claim_token_digest = ?', digest))
    },

    async listAgents() {
      return all('select * from bellhop_agents order by id').map((row) => toAgent(row)!)
    },

    async updateAgent(id, patch) {
      applyPatch('bellhop_agents', AGENT_COLUMNS, id, patch)
      const agent = await store.findAgent(id)
      if (!agent) throw new Error(`No agent ${id}`)
      return agent
    },

    async deleteAgent(id) {
      run('delete from bellhop_agents where id = ?', Number(id))
    },

    async agentsNeedingRenewal(before) {
      return all(
        `select * from bellhop_agents
          where token_digest is not null
            and credential_expires_at is not null
            and credential_expires_at < ?`,
        before
      ).map((row) => toAgent(row)!)
    },

    async touchAgents(ids, at) {
      if (ids.length === 0) return
      const placeholders = ids.map(() => '?').join(', ')
      run(
        `update bellhop_agents set last_seen_at = ? where id in (${placeholders})`,
        at,
        ...ids.map(Number)
      )
    },

    async createJob(input) {
      const result = run(
        `insert into bellhop_jobs (agent_id, kind, format, printer, options, data, url, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        Number(input.agentId),
        input.kind,
        input.format,
        input.printer,
        input.options === null ? null : JSON.stringify(input.options),
        input.data,
        input.url,
        Date.now()
      )
      return toJob(one('select * from bellhop_jobs where id = ?', Number(result.lastInsertRowid)))!
    },

    async findJob(id) {
      return toJob(one('select * from bellhop_jobs where id = ?', Number(id)))
    },

    async updateJob(id, patch) {
      applyPatch('bellhop_jobs', JOB_COLUMNS, id, patch)
      const job = await store.findJob(id)
      if (!job) throw new Error(`No job ${id}`)
      return job
    },

    async unfinishedJobs(agentId) {
      return all(
        `select * from bellhop_jobs
          where agent_id = ? and status in ('pending', 'sent') order by id`,
        Number(agentId)
      ).map((row) => toJob(row)!)
    },

    async recentJobs(limit) {
      return all('select * from bellhop_jobs order by id desc limit ?', limit).map((row) =>
        toJob(row)!
      )
    },

    async createSession(id, agentId) {
      run(
        'insert into bellhop_sessions (id, agent_id, last_polled_at) values (?, ?, ?)',
        id,
        Number(agentId),
        Date.now()
      )
    },

    async findSession(id) {
      return toSession(one('select * from bellhop_sessions where id = ?', id))
    },

    async findLiveSessionByAgent(agentId, freshMs) {
      return toSession(
        one(
          `select * from bellhop_sessions
            where agent_id = ? and last_polled_at >= ?
            order by last_polled_at desc limit 1`,
          Number(agentId),
          Date.now() - freshMs
        )
      )
    },

    async updateSession(id, patch) {
      if (patch.handshakeComplete === undefined) return
      run(
        'update bellhop_sessions set handshake_complete = ? where id = ?',
        patch.handshakeComplete ? 1 : 0,
        id
      )
    },

    async touchSession(id) {
      run('update bellhop_sessions set last_polled_at = ? where id = ?', Date.now(), id)
    },

    async deleteSession(id) {
      // The messages cascade with the session row.
      run('delete from bellhop_sessions where id = ?', id)
    },

    async staleSessions(olderThanMs) {
      return all(
        'select * from bellhop_sessions where last_polled_at < ?',
        Date.now() - olderThanMs
      ).map((row) => toSession(row)!)
    },

    async enqueueSessionMessages(sessionId, messages) {
      if (!one('select id from bellhop_sessions where id = ?', sessionId)) return
      db.exec('begin')
      try {
        for (const message of messages) {
          run(
            'insert into bellhop_session_messages (session_id, message) values (?, ?)',
            sessionId,
            JSON.stringify(message)
          )
        }
        db.exec('commit')
      } catch (error) {
        db.exec('rollback')
        throw error
      }
    },

    async drainSessionMessages(sessionId) {
      // Atomic remove-and-return, so two processes draining the same session
      // never both receive a message.
      db.exec('begin immediate')
      try {
        const rows = all(
          'select id, message from bellhop_session_messages where session_id = ? order by id',
          sessionId
        )
        run('delete from bellhop_session_messages where session_id = ?', sessionId)
        db.exec('commit')
        return rows.map((row) => JSON.parse(String(row.message)) as ServerMessage)
      } catch (error) {
        db.exec('rollback')
        throw error
      }
    },

    async close() {
      db.close()
    },
  }

  return store
}
