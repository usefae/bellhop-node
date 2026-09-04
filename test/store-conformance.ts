import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../src/store/types.js'

/**
 * The behaviour every `Store` must have, as a suite any implementation can
 * run. `open` returns a fresh, empty store for each test; `close` is called
 * after it.
 */
export function storeConformance(name: string, open: () => Store | Promise<Store>): void {
  describe(`${name} conforms to Store`, () => {
    let store: Store
    beforeEach(async () => {
      store = await open()
    })
    afterEach(async () => {
      await store.close?.()
    })

    const agentInput = (n = 1) => ({
      remoteId: n,
      label: `Desk ${n}`,
      claimTokenDigest: `claim-${n}`,
      claimExpiresAt: Date.now() + 60_000,
    })
    const jobInput = (agentId: string) => ({
      agentId,
      kind: 'label',
      format: 'zpl' as const,
      printer: null,
      options: null,
      data: 'x',
      url: null,
    })

    it('creates an agent with an empty inventory and finds it by id and by digest', async () => {
      const created = await store.createAgent(agentInput())
      expect(created).toMatchObject({
        label: 'Desk 1',
        tokenDigest: null,
        capabilities: [],
        printers: [],
        defaultPrinters: {},
        lastSeenAt: null,
      })
      expect(await store.findAgent(created.id)).toEqual(created)
      expect(await store.findAgentByClaimDigest('claim-1')).toEqual(created)
      expect(await store.findAgentByTokenDigest('claim-1')).toBeNull()
      expect(await store.findAgent('999')).toBeNull()
      expect(await store.listAgents()).toEqual([created])
    })

    it('treats updates as patches: absent keys stay, null clears, arrays and maps round-trip', async () => {
      const { id } = await store.createAgent(agentInput())
      await store.updateAgent(id, {
        tokenDigest: 'tok',
        credential: 'a.b.c',
        appName: 'Deliver',
        printers: [{ id: 'Z', name: 'Zebra', capabilities: { papers: ['w288h432'] } }],
        defaultPrinters: { label: 'Z' },
        capabilities: ['print:zpl'],
      })
      await store.updateAgent(id, { appName: null, claimTokenDigest: null })

      const agent = (await store.findAgent(id))!
      expect(agent.credential).toBe('a.b.c')
      expect(agent.appName).toBeNull()
      expect(agent.claimTokenDigest).toBeNull()
      expect(agent.printers[0]!.capabilities).toEqual({ papers: ['w288h432'] })
      expect(agent.defaultPrinters).toEqual({ label: 'Z' })
      expect(agent.capabilities).toEqual(['print:zpl'])
      expect(await store.findAgentByTokenDigest('tok')).toEqual(agent)
      await expect(store.updateAgent('999', { label: 'x' })).rejects.toThrow()
    })

    it('never reuses a job id, even after the agent and its jobs are deleted', async () => {
      const first = await store.createAgent(agentInput(1))
      const before = await store.createJob(jobInput(first.id))
      await store.deleteAgent(first.id)
      expect(await store.findJob(before.id)).toBeNull()
      expect(await store.findAgent(first.id)).toBeNull()

      const second = await store.createAgent(agentInput(2))
      const after = await store.createJob(jobInput(second.id))
      expect(after.id).not.toBe(before.id)
      expect(Number(after.id)).toBeGreaterThan(Number(before.id))
    })

    it('orders unfinished jobs oldest first and recent jobs newest first', async () => {
      const { id } = await store.createAgent(agentInput())
      const a = await store.createJob(jobInput(id))
      const b = await store.createJob({ ...jobInput(id), printer: 'Z', options: { copies: 2 } })
      const c = await store.createJob(jobInput(id))
      await store.updateJob(b.id, { status: 'sent', sentAt: 1 })
      await store.updateJob(c.id, { status: 'printed', ackedAt: 2 })

      expect((await store.unfinishedJobs(id)).map((j) => j.id)).toEqual([a.id, b.id])
      expect((await store.recentJobs(2)).map((j) => j.id)).toEqual([c.id, b.id])
      expect((await store.findJob(b.id))!).toMatchObject({ printer: 'Z', options: { copies: 2 } })
      await expect(store.updateJob('999', { status: 'sent' })).rejects.toThrow()
    })

    it('agentsNeedingRenewal skips unpaired agents and later expiries', async () => {
      const due = await store.createAgent(agentInput(1))
      const later = await store.createAgent(agentInput(2))
      const unpaired = await store.createAgent(agentInput(3))
      await store.updateAgent(due.id, { tokenDigest: 't1', credentialExpiresAt: 100 })
      await store.updateAgent(later.id, { tokenDigest: 't2', credentialExpiresAt: 1_000 })
      await store.updateAgent(unpaired.id, { credentialExpiresAt: 100 })

      expect((await store.agentsNeedingRenewal(500)).map((a) => a.id)).toEqual([due.id])
    })

    it('touchAgents stamps a batch and tolerates unknown ids', async () => {
      if (!store.touchAgents) return
      const a = await store.createAgent(agentInput(1))
      const b = await store.createAgent(agentInput(2))
      await store.touchAgents([a.id, b.id, '999'], 12_345)
      expect((await store.findAgent(a.id))!.lastSeenAt).toBe(12_345)
      expect((await store.findAgent(b.id))!.lastSeenAt).toBe(12_345)
    })

    it('finds a live session, sweeps stale ones, and shares the handshake flag', async () => {
      const { id } = await store.createAgent(agentInput())
      await store.createSession('s1', id)
      expect((await store.findSession('s1'))!).toMatchObject({
        agentId: id,
        handshakeComplete: false,
      })
      expect((await store.findLiveSessionByAgent(id, 60_000))!.id).toBe('s1')

      await store.updateSession('s1', { handshakeComplete: true })
      expect((await store.findSession('s1'))!.handshakeComplete).toBe(true)

      // Let the clock move so "polled within 1 ms" is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(await store.findLiveSessionByAgent(id, 1)).toBeNull()
      expect(await store.staleSessions(60_000)).toEqual([])
      expect((await store.staleSessions(1)).map((s) => s.id)).toEqual(['s1'])

      const before = (await store.findSession('s1'))!.lastPolledAt
      await store.touchSession('s1')
      expect((await store.findSession('s1'))!.lastPolledAt).toBeGreaterThan(before)
      expect((await store.findLiveSessionByAgent(id, 60_000))!.id).toBe('s1')
    })

    it('drains a queue in order and exactly once, and discards it with the session', async () => {
      const { id } = await store.createAgent(agentInput())
      await store.createSession('s1', id)
      await store.enqueueSessionMessages('s1', [{ type: 'ping' }])
      await store.enqueueSessionMessages('s1', [{ type: 'credential', credential: 'a.b.c' }])

      expect(await store.drainSessionMessages('s1')).toEqual([
        { type: 'ping' },
        { type: 'credential', credential: 'a.b.c' },
      ])
      expect(await store.drainSessionMessages('s1')).toEqual([])

      await store.enqueueSessionMessages('s1', [{ type: 'ping' }])
      await store.deleteSession('s1')
      expect(await store.findSession('s1')).toBeNull()
      expect(await store.drainSessionMessages('s1')).toEqual([])
      // Enqueueing to a session that is gone is a no-op, not an error.
      await store.enqueueSessionMessages('nope', [{ type: 'ping' }])
      expect(await store.drainSessionMessages('nope')).toEqual([])
    })

    it('deleteAgent cascades to jobs and sessions', async () => {
      const { id } = await store.createAgent(agentInput())
      const job = await store.createJob(jobInput(id))
      await store.createSession('s1', id)
      await store.enqueueSessionMessages('s1', [{ type: 'ping' }])

      await store.deleteAgent(id)
      expect(await store.findJob(job.id)).toBeNull()
      expect(await store.findSession('s1')).toBeNull()
      expect(await store.drainSessionMessages('s1')).toEqual([])
    })
  })
}
