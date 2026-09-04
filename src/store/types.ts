/**
 * The storage seam. `memoryStore()` and `sqliteStore()` ship with the package;
 * implement `Store` over your own database and everything above it works
 * unchanged.
 */

import type { Capability, Printer, PrintFormat, PrintOptions, ServerMessage } from '../types.js'

export interface AgentRecord {
  /** Yours. Opaque to this library, rendered as a string on the wire. */
  id: string
  /** The bellhop.dev agent id, from `POST /api/v1/agents`. */
  remoteId: number
  label: string
  /** SHA-256 of the agent token. Null until the agent is first claimed. */
  tokenDigest: string | null
  /** The signed credential. Opaque: store it, hand it over, replace it at renewal. */
  credential: string | null
  credentialExpiresAt: number | null
  claimTokenDigest: string | null
  claimExpiresAt: number | null
  /** Branding as bellhop.dev has it, captured at activation. */
  appName: string | null
  accentColor: string | null
  /** Everything below is from the most recent `hello`, which replaces the last one whole. */
  agentVersion: string | null
  platform: string | null
  capabilities: Capability[]
  /** The printers the operator has shared with this pairing, and what each can do. */
  printers: Printer[]
  /** Role to printer `id`: where a job that names no printer goes. */
  defaultPrinters: Record<string, string>
  lastSeenAt: number | null
  createdAt: number
}

export type AgentPatch = Partial<Omit<AgentRecord, 'id' | 'createdAt'>>

export interface JobRecord {
  id: string
  agentId: string
  kind: string
  format: PrintFormat
  /** The printer `id` this job named, or null to route by `format`. */
  printer: string | null
  /** What the caller asked for, already refused if it was malformed. */
  options: PrintOptions | null
  /** Base64 document bytes. Kept even when delivered by `url`. */
  data: string | null
  url: string | null
  status: JobStatus
  error: string | null
  createdAt: number
  sentAt: number | null
  ackedAt: number | null
}

export type JobStatus = 'pending' | 'sent' | 'printed' | 'failed'

export type JobPatch = Partial<Omit<JobRecord, 'id' | 'agentId' | 'createdAt'>>

/**
 * HTTP transport only. The session's message queue lives in the store as well,
 * so any process can enqueue to a session and any process can serve its polls
 * (TRANSPORTS.md §2.4).
 */
export interface SessionRecord {
  id: string
  agentId: string
  /**
   * Set after the first `hello`, so a poll served by another process does not
   * mistake a mid-session `hello` for a handshake.
   */
  handshakeComplete: boolean
  lastPolledAt: number
}

/**
 * Where agents, jobs, and HTTP sessions live. Implement it over Prisma,
 * Drizzle, Kysely, Mongo, or your own tables. Every method is async so any
 * database fits.
 *
 * Three things an implementation must preserve:
 *
 * 1. A job `id` is never reused, even after deletion. The agent deduplicates
 *    on it, so a reused id is a label that never prints.
 * 2. `tokenDigest` and `claimTokenDigest` hold digests, never tokens.
 * 3. `updateAgent` and `updateJob` are patches: an absent key leaves the
 *    stored value alone, and an explicit `null` clears it.
 *
 * `test/store-conformance.ts` in the package repository checks all of this
 * against both shipped stores and can be pointed at yours.
 */
export interface Store {
  createAgent(input: {
    remoteId: number
    label: string
    claimTokenDigest: string
    claimExpiresAt: number
  }): Promise<AgentRecord>

  findAgent(id: string): Promise<AgentRecord | null>
  findAgentByTokenDigest(digest: string): Promise<AgentRecord | null>
  findAgentByClaimDigest(digest: string): Promise<AgentRecord | null>
  listAgents(): Promise<AgentRecord[]>
  updateAgent(id: string, patch: AgentPatch): Promise<AgentRecord>
  deleteAgent(id: string): Promise<void>

  /** Paired agents whose credential expires before `before`. */
  agentsNeedingRenewal(before: number): Promise<AgentRecord[]>

  /**
   * Optional bulk form of the presence write. Implement it as one
   * `UPDATE … WHERE id IN (…)` and each flush is a single statement. Must
   * tolerate ids that no longer exist. Absent, the flush calls `updateAgent`
   * per id.
   */
  touchAgents?(ids: string[], at: number): Promise<void>

  createJob(input: {
    agentId: string
    kind: string
    format: PrintFormat
    printer: string | null
    options: PrintOptions | null
    data: string | null
    url: string | null
  }): Promise<JobRecord>

  findJob(id: string): Promise<JobRecord | null>
  updateJob(id: string, patch: JobPatch): Promise<JobRecord>
  /** Jobs still `pending` or `sent`, oldest first. Redelivered at each handshake. */
  unfinishedJobs(agentId: string): Promise<JobRecord[]>
  recentJobs(limit: number): Promise<JobRecord[]>

  createSession(id: string, agentId: string): Promise<void>
  findSession(id: string): Promise<SessionRecord | null>
  /** The agent's most recent session polled within `freshMs`, or null. */
  findLiveSessionByAgent(agentId: string, freshMs: number): Promise<SessionRecord | null>
  updateSession(id: string, patch: { handshakeComplete?: boolean }): Promise<void>
  touchSession(id: string): Promise<void>
  /** Must also discard anything still queued for the session. */
  deleteSession(id: string): Promise<void>
  staleSessions(olderThanMs: number): Promise<SessionRecord[]>

  /** Append to the session's queue, preserving order. No-op if the session is gone. */
  enqueueSessionMessages(sessionId: string, messages: ServerMessage[]): Promise<void>
  /**
   * Remove and return everything queued, in order. Must be atomic: two
   * processes draining concurrently must never both receive a message.
   */
  drainSessionMessages(sessionId: string): Promise<ServerMessage[]>

  /** Release handles. Called by `bellhop.close()`. */
  close?(): Promise<void>
}
