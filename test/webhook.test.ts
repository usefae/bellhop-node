import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeAgent } from '../src/testing/index.js'
import { testBellhop } from './helpers.js'
import type { Bellhop, BellhopResponse } from '../src/bellhop.js'

let open: Bellhop[] = []

afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

const PAYLOAD = { event: 'app.entitlements_changed', app: 'bh_pk_test' }

function deliver(
  bellhop: Bellhop,
  header: string | undefined,
  body: unknown = PAYLOAD
): Promise<BellhopResponse> {
  return bellhop.handleRequest({
    method: 'POST',
    path: '/webhook',
    getHeader: (name) => (name.toLowerCase() === 'bellhop-signature' ? header : undefined),
    body,
    ip: '10.0.0.9',
  })
}

describe('the entitlements webhook', () => {
  it('accepts a verified delivery and re-mints every paired agent behind the response', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })

    const response = await deliver(bellhop, licensing.signWebhook())
    expect(response.status).toBe(202)

    await vi.waitFor(() => expect(licensing.state.renewals).toBe(1))
    await vi.waitFor(() =>
      expect(agent.messages.some((message) => message.type === 'credential')).toBe(true)
    )
  })

  it('refuses a delivery whose signature covers a different event or app', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)

    const forAnotherApp = licensing.signWebhook({ app: 'bh_pk_other' })
    expect((await deliver(bellhop, forAnotherApp)).status).toBe(401)

    const forAnotherEvent = licensing.signWebhook({ event: 'app.deleted' })
    expect((await deliver(bellhop, forAnotherEvent)).status).toBe(401)

    expect(licensing.state.renewals).toBe(0)
  })

  it('refuses stale, garbled, and unknown-key signatures', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)

    const stale = licensing.signWebhook({ t: Math.floor(Date.now() / 1000) - 6 * 60 })
    expect((await deliver(bellhop, stale)).status).toBe(401)

    expect((await deliver(bellhop, undefined)).status).toBe(401)
    expect((await deliver(bellhop, 'not a signature at all')).status).toBe(401)
    expect((await deliver(bellhop, licensing.signWebhook({ kid: 'unknown' }))).status).toBe(401)
  })

  it('answers 503 when the key set cannot be fetched, so bellhop.dev redelivers', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    licensing.state.failKeys = true

    expect((await deliver(bellhop, licensing.signWebhook())).status).toBe(503)
  })
})

describe('the removal webhook', () => {
  it('retires the removed agent instead of re-minting the fleet', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Gone Desk' })
    await fakeAgent(bellhop, { claimToken })
    await bellhop.agents.create({ label: 'Kept Desk' })
    for (const remote of licensing.state.remoteAgents) {
      if (remote.label === 'Gone Desk') remote.status = 'deactivated'
    }

    const body = { event: 'agent.deactivated', app: 'bh_pk_test' }
    const header = licensing.signWebhook({ event: 'agent.deactivated' })
    expect((await deliver(bellhop, header, body)).status).toBe(202)

    await vi.waitFor(async () => {
      const labels = (await bellhop.agents.list()).map((agent) => agent.label)
      expect(labels).toEqual(['Kept Desk'])
    })
    expect(licensing.state.renewals).toBe(0)
  })

  it('an event this library has never heard of still refreshes', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    await fakeAgent(bellhop, { claimToken })

    const body = { event: 'app.something_new', app: 'bh_pk_test' }
    const header = licensing.signWebhook({ event: 'app.something_new' })
    expect((await deliver(bellhop, header, body)).status).toBe(202)

    await vi.waitFor(() => expect(licensing.state.renewals).toBe(1))
  })
})

describe('retireDeactivated', () => {
  it('removes exactly the agents bellhop.dev lists as deactivated, unpaired ones included', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Gone Desk' })
    const gone = await fakeAgent(bellhop, { claimToken })
    await bellhop.agents.create({ label: 'Kept Desk' })
    for (const remote of licensing.state.remoteAgents) {
      if (remote.label === 'Gone Desk') remote.status = 'deactivated'
    }

    const report = await bellhop.retireDeactivated()

    expect(report.retired).toEqual([gone.agentId])
    expect((await bellhop.agents.list()).map((agent) => agent.label)).toEqual(['Kept Desk'])
  })

  it('with nothing deactivated at the source, retires nothing', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    await fakeAgent(bellhop, { claimToken })

    expect((await bellhop.retireDeactivated()).retired).toHaveLength(0)
    expect(await bellhop.agents.list()).toHaveLength(1)
  })
})

describe('refresh', () => {
  it('re-mints every paired agent however far off expiry is, and skips unpaired ones', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Paired Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })
    await bellhop.agents.create({ label: 'Never Claimed' })

    expect((await bellhop.renew()).renewed).toHaveLength(0)

    const report = await bellhop.refresh()
    expect(report.renewed).toEqual([agent.agentId])
    expect(licensing.state.renewals).toBe(1)
  })

  it('coalesces concurrent calls into one run plus one queued behind it', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    await fakeAgent(bellhop, { claimToken })

    await Promise.all([bellhop.refresh(), bellhop.refresh(), bellhop.refresh()])

    expect(licensing.state.renewals).toBe(2)
  })
})
