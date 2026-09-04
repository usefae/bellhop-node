/**
 * The default store. Everything lives in a Map and vanishes on exit. A restart
 * loses which jobs were acknowledged, so use `sqliteStore()` for anything
 * beyond tests.
 */

import type { JobPatch, JobRecord, SessionRecord, AgentPatch, AgentRecord, Store } from './types.js'
import type { ServerMessage } from '../types.js'

export function memoryStore(): Store {
  const agents = new Map<string, AgentRecord>()
  const jobs = new Map<string, JobRecord>()
  const sessions = new Map<string, SessionRecord>()
  const sessionMessages = new Map<string, ServerMessage[]>()
  let nextAgent = 1
  // Never reset, so a job id is never reused (PROTOCOL.md §8).
  let nextJob = 1

  const clone = <T>(value: T): T => (value === null ? value : structuredClone(value))

  return {
    async createAgent(input) {
      const agent: AgentRecord = {
        id: String(nextAgent++),
        remoteId: input.remoteId,
        label: input.label,
        tokenDigest: null,
        credential: null,
        credentialExpiresAt: null,
        claimTokenDigest: input.claimTokenDigest,
        claimExpiresAt: input.claimExpiresAt,
        appName: null,
        accentColor: null,
        agentVersion: null,
        platform: null,
        capabilities: [],
        printers: [],
        defaultPrinters: {},
        lastSeenAt: null,
        createdAt: Date.now(),
      }
      agents.set(agent.id, agent)
      return clone(agent)
    },

    async findAgent(id) {
      return clone(agents.get(id) ?? null)
    },

    async findAgentByTokenDigest(digest) {
      for (const agent of agents.values()) {
        if (agent.tokenDigest === digest) return clone(agent)
      }
      return null
    },

    async findAgentByClaimDigest(digest) {
      for (const agent of agents.values()) {
        if (agent.claimTokenDigest === digest) return clone(agent)
      }
      return null
    },

    async listAgents() {
      return [...agents.values()].map(clone)
    },

    async updateAgent(id, patch: AgentPatch) {
      const agent = agents.get(id)
      if (!agent) throw new Error(`No agent ${id}`)
      Object.assign(agent, patch)
      return clone(agent)
    },

    async deleteAgent(id) {
      agents.delete(id)
      for (const [jobId, job] of jobs) if (job.agentId === id) jobs.delete(jobId)
      for (const [sessionId, session] of sessions) {
        if (session.agentId === id) {
          sessions.delete(sessionId)
          sessionMessages.delete(sessionId)
        }
      }
    },

    async agentsNeedingRenewal(before) {
      return [...agents.values()]
        .filter((s) => s.tokenDigest && s.credentialExpiresAt && s.credentialExpiresAt < before)
        .map(clone)
    },

    async touchAgents(ids, at) {
      for (const id of ids) {
        const agent = agents.get(id)
        if (agent) agent.lastSeenAt = at
      }
    },

    async createJob(input) {
      const job: JobRecord = {
        id: String(nextJob++),
        agentId: input.agentId,
        kind: input.kind,
        format: input.format,
        printer: input.printer,
        options: input.options,
        data: input.data,
        url: input.url,
        status: 'pending',
        error: null,
        createdAt: Date.now(),
        sentAt: null,
        ackedAt: null,
      }
      jobs.set(job.id, job)
      return clone(job)
    },

    async findJob(id) {
      return clone(jobs.get(id) ?? null)
    },

    async updateJob(id, patch: JobPatch) {
      const job = jobs.get(id)
      if (!job) throw new Error(`No job ${id}`)
      Object.assign(job, patch)
      return clone(job)
    },

    async unfinishedJobs(agentId) {
      return [...jobs.values()]
        .filter((j) => j.agentId === agentId && (j.status === 'pending' || j.status === 'sent'))
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map(clone)
    },

    async recentJobs(limit) {
      return [...jobs.values()]
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, limit)
        .map(clone)
    },

    async createSession(id, agentId) {
      sessions.set(id, { id, agentId, handshakeComplete: false, lastPolledAt: Date.now() })
    },

    async findSession(id) {
      return clone(sessions.get(id) ?? null)
    },

    async findLiveSessionByAgent(agentId, freshMs) {
      const cutoff = Date.now() - freshMs
      const live = [...sessions.values()]
        .filter((s) => s.agentId === agentId && s.lastPolledAt >= cutoff)
        .sort((a, b) => b.lastPolledAt - a.lastPolledAt)
      return clone(live[0] ?? null)
    },

    async updateSession(id, patch) {
      const session = sessions.get(id)
      if (session && patch.handshakeComplete !== undefined) {
        session.handshakeComplete = patch.handshakeComplete
      }
    },

    async touchSession(id) {
      const session = sessions.get(id)
      if (session) session.lastPolledAt = Date.now()
    },

    async deleteSession(id) {
      sessions.delete(id)
      sessionMessages.delete(id)
    },

    async staleSessions(olderThanMs) {
      const cutoff = Date.now() - olderThanMs
      return [...sessions.values()].filter((s) => s.lastPolledAt < cutoff).map(clone)
    },

    async enqueueSessionMessages(sessionId, messages) {
      if (!sessions.has(sessionId)) return
      const queue = sessionMessages.get(sessionId) ?? []
      queue.push(...messages.map(clone))
      sessionMessages.set(sessionId, queue)
    },

    async drainSessionMessages(sessionId) {
      return sessionMessages.get(sessionId)?.splice(0) ?? []
    },
  }
}
