import { afterEach, describe, expect, it, vi } from 'vitest'
import { testBellhop } from './helpers.js'
import { bellhopFetch } from '../src/adapters/web.js'
import type { Bellhop } from '../src/bellhop.js'

let open: Bellhop[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const bellhop of open) await bellhop.close()
  open = []
})

const claim = (bellhop: Bellhop, claim_token: string) =>
  bellhop.handleRequest({
    method: 'POST',
    path: '/claim',
    getHeader: () => undefined,
    body: { claim_token },
    ip: '10.0.0.1',
  })

// Pair one agent and back-date its credential so it is due.
async function expiringAgent(bellhop: Bellhop): Promise<void> {
  const created = await bellhop.agents.create({ label: 'Desk' })
  await claim(bellhop, created.claimToken)
  await bellhop.store.updateAgent(created.agent.id, {
    credentialExpiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
  })
}

const SIX_HOURS = 6 * 60 * 60 * 1000

describe('automatic renewal', () => {
  it('begins the moment a transport is attached', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    await expiringAgent(bellhop)

    bellhopFetch(bellhop)

    await vi.waitFor(() => expect(licensing.state.renewals).toBe(1))
  })

  it('attaching twice starts one timer, not two', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    await expiringAgent(bellhop)
    // Keep every renewed credential inside the renewal window, so each
    // interval tick renews once per timer: one timer means one more, two
    // would mean two.
    licensing.state.credentialTtlMs = 5 * 24 * 60 * 60 * 1000
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })

    bellhopFetch(bellhop)
    bellhopFetch(bellhop)
    await vi.waitFor(() => expect(licensing.state.renewals).toBe(1))

    await vi.advanceTimersByTimeAsync(SIX_HOURS)
    expect(licensing.state.renewals).toBe(2)
  })

  it('stays manual with autoRenew: false', async () => {
    const { bellhop, licensing } = testBellhop({ autoRenew: false })
    open.push(bellhop)
    await expiringAgent(bellhop)
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })

    bellhopFetch(bellhop)
    await vi.advanceTimersByTimeAsync(SIX_HOURS)
    expect(licensing.state.renewals).toBe(0)

    // The manual arrangement still works.
    const result = await bellhop.renew()
    expect(result.renewed.length).toBe(1)
  })
})
