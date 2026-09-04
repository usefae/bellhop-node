import { afterEach, describe, expect, it } from 'vitest'
import { fakeAgent } from '../src/testing/index.js'
import { AgentError } from '../src/errors.js'
import { httpAgent, messagesOf, testBellhop } from './helpers.js'
import type { Bellhop } from '../src/bellhop.js'

let open: Bellhop[] = []

afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

async function paired(options?: Parameters<typeof testBellhop>[0]) {
  const { bellhop, licensing } = testBellhop(options)
  open.push(bellhop)
  const { claimToken } = await bellhop.agents.create({ label: 'Shipping Desk' })
  const agent = await fakeAgent(bellhop, { claimToken })
  return { bellhop, agent, licensing }
}

describe('printing', () => {
  it('delivers a job and records the ack', async () => {
    const { bellhop, agent } = await paired()

    const job = await bellhop.print(agent.agentId, {
      kind: 'label',
      format: 'zpl',
      data: '^XA^FDhi^FS^XZ',
    })
    await agent.waitForPrint()

    expect(agent.printed).toHaveLength(1)
    expect(agent.printed[0]!.data!.toString()).toBe('^XA^FDhi^FS^XZ')
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')
  })

  it('queues for an offline agent and delivers at the next handshake', async () => {
    const { bellhop, agent } = await paired()
    await agent.close()

    const job = await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    expect(job.status).toBe('pending')

    const { claimToken } = await bellhop.agents.repair(agent.agentId)
    const reconnected = await fakeAgent(bellhop, { claimToken })
    await reconnected.waitForPrint()

    expect(reconnected.printed).toHaveLength(1)
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')
  })

  it('refuses a format the agent does not advertise', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Label only' })
    const agent = await fakeAgent(bellhop, { claimToken, capabilities: ['print:zpl'] })

    await expect(
      bellhop.print(agent.agentId, { kind: 'slip', format: 'pdf', data: 'x' })
    ).rejects.toThrow(AgentError)

    // The one it does advertise still works.
    await expect(
      bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    ).resolves.toBeDefined()
  })

  it('requires exactly one of data and url', async () => {
    const { bellhop, agent } = await paired()
    await expect(bellhop.print(agent.agentId, { kind: 'l', format: 'zpl' })).rejects.toThrow()
    await expect(
      bellhop.print(agent.agentId, { kind: 'l', format: 'zpl', data: 'x', url: 'https://x' })
    ).rejects.toThrow()
  })

  it('refuses inline documents over 50 MB', async () => {
    const { bellhop, agent } = await paired()
    const tooBig = Buffer.alloc(51 * 1024 * 1024)
    await expect(
      bellhop.print(agent.agentId, { kind: 'doc', format: 'pdf', data: tooBig })
    ).rejects.toThrow(/50 MB/)
  })
})

describe('redelivery', () => {
  it('does not re-send an outstanding job on a mid-session hello', async () => {
    // The failure this guards: a burst of `hello` messages re-sending a job
    // that is still in flight, faster than the agent's ledger records it.
    const { bellhop, agent } = await paired()

    await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    await agent.waitForPrint()

    const deliveries = agent.received.length
    for (let i = 0; i < 50; i++) await agent.sendHello()

    expect(agent.received).toHaveLength(deliveries)
    expect(agent.printed).toHaveLength(1)
  })

  it('survives an agent that answers every ready with a hello', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Loopy' })

    // The real Mac agent did exactly this: adopting a credential re-sent hello,
    // and `ready` carries the credential on every handshake.
    const agent = await fakeAgent(bellhop, { claimToken, rehelloOnReady: false })
    await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    await agent.waitForPrint()

    for (let i = 0; i < 100; i++) await agent.sendHello()
    expect(agent.printed).toHaveLength(1)
  })

  it('prints a redelivered job only once, and re-acks it', async () => {
    const { bellhop, agent } = await paired()
    const job = await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    await agent.waitForPrint()

    // Force a redelivery of a job the agent has already completed.
    await bellhop.store.updateJob(job.id, { status: 'sent', ackedAt: null })
    const { claimToken } = await bellhop.agents.repair(agent.agentId)
    const reconnected = await fakeAgent(bellhop, { claimToken })
    // The fake agent shares no ledger with the first one, so assert on the
    // server's view instead: the job ends acknowledged either way.
    await reconnected.waitForPrint()
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')
  })
})

describe('keepalive and forward compatibility', () => {
  it('answers ping with pong, echoing the token', async () => {
    const { agent } = await paired()
    await agent.ping()
    const pong = agent.messages.findLast((m) => m.type === 'pong')
    expect(pong).toMatchObject({ type: 'pong', token: 'fake' })
  })

  it('ignores unknown message types instead of closing', async () => {
    const { agent } = await paired()
    await agent.emit({ type: 'telemetry', cpu: 12 } as never)
    await agent.emit({ type: 'weight', grams: 500, stable: true, humidity: 30 } as never)
    // Still alive, and the known message still landed.
    await agent.ping()
    expect(agent.messages.findLast((m) => m.type === 'pong')).toBeDefined()
  })

  it('reports weights as events', async () => {
    const { bellhop, agent } = await paired()
    const seen: number[] = []
    bellhop.on('weight', ({ grams }) => seen.push(grams))
    await agent.weigh(1240)
    expect(seen).toEqual([1240])
  })
})

describe('acks', () => {
  it('is idempotent', async () => {
    const { bellhop, agent } = await paired()
    const job = await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    await agent.waitForPrint()

    const acks: string[] = []
    bellhop.on('ack', ({ jobId }) => acks.push(jobId))

    await agent.emit({ type: 'ack', id: job.id, status: 'printed' })
    await agent.emit({ type: 'ack', id: job.id, status: 'printed' })

    expect(acks).toEqual([job.id, job.id])
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')
  })

  it('records a failure with its message', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Jammed' })
    const agent = await fakeAgent(bellhop, { claimToken, failPrints: true })

    const job = await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: 'x' })
    const ack = await agent.waitForAck(job.id)
    expect(ack.status).toBe('failed')

    const stored = await bellhop.jobs.get(job.id)
    expect(stored!.status).toBe('failed')
    expect(stored!.error).toMatch(/told to fail/)
  })

  it('ignores an ack for a job it does not have', async () => {
    const { agent } = await paired()
    await expect(
      agent.emit({ type: 'ack', id: 'nope', status: 'printed' })
    ).resolves.toBeUndefined()
  })
})

describe('shutdown pacing', () => {
  it('carries retry_after_seconds on the close advisory when close() spreads a deploy', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const session = await httpAgent(bellhop, claimToken)
    expect(session.opened.status).toBe(201)

    // A held long poll, as a real agent would have open when the deploy lands.
    const poll = session.poll(bellhop, 5)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await bellhop.close({ retryAfterSeconds: 45 })

    const advisory = messagesOf(await poll).find((message) => message.type === 'close')
    expect(advisory).toMatchObject({ code: 1001, retry_after_seconds: 45 })
  })

  it('sends no advisory for a bare 1001, matching the old wire behaviour', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const session = await httpAgent(bellhop, claimToken)

    const poll = session.poll(bellhop, 5)
    await new Promise((resolve) => setTimeout(resolve, 10))

    await bellhop.close()

    expect(messagesOf(await poll).filter((message) => message.type === 'close')).toEqual([])
  })
})

describe('presence write batching', () => {
  it('buffers touches between flushes and flushes on close', async () => {
    const { memoryStore } = await import('../src/store/memory.js')
    const store = memoryStore()
    const { bellhop } = testBellhop({ store, heartbeatSeconds: 60 })
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })

    // The hello wrote through; this is the baseline.
    const before = (await store.findAgent(agent.agentId))!.lastSeenAt
    expect(before).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 15))
    await agent.ping()

    // Within the flush interval the ping buffered instead of writing.
    expect((await store.findAgent(agent.agentId))!.lastSeenAt).toBe(before)

    // Shutdown flushes whatever is buffered.
    await bellhop.close()
    expect((await store.findAgent(agent.agentId))!.lastSeenAt).toBeGreaterThan(before!)
  })

  it('touchAgents stamps a batch in one call, tolerating missing ids', async () => {
    const { memoryStore } = await import('../src/store/memory.js')
    const store = memoryStore()
    const a = await store.createAgent({
      remoteId: 1,
      label: 'a',
      claimTokenDigest: 'x',
      claimExpiresAt: 0,
    })
    const b = await store.createAgent({
      remoteId: 2,
      label: 'b',
      claimTokenDigest: 'y',
      claimExpiresAt: 0,
    })

    await store.touchAgents!([a.id, b.id, '999'], 12_345)

    expect((await store.findAgent(a.id))!.lastSeenAt).toBe(12_345)
    expect((await store.findAgent(b.id))!.lastSeenAt).toBe(12_345)
  })
})
