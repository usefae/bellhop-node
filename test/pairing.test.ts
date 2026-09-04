import { afterEach, describe, expect, it } from 'vitest'
import { testBellhop } from './helpers.js'
import type { Bellhop } from '../src/bellhop.js'

let open: Bellhop[] = []
afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

const claim = (bellhop: Bellhop, claim_token: string, ip = '10.0.0.1') =>
  bellhop.handleRequest({
    method: 'POST',
    path: '/claim',
    getHeader: () => undefined,
    body: { claim_token },
    ip,
  })

describe('the claim exchange', () => {
  it('returns a token, branding, and both transports', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Shipping Desk' })

    const response = await claim(bellhop, claimToken)
    expect(response.status).toBe(200)

    const body = response.body as Record<string, unknown>
    expect(body.agent_token).toEqual(expect.any(String))
    expect(body.agent_name).toBe('Shipping Desk')
    // Branding comes from the activation, so the name in `ready` matches this.
    expect(body.app_name).toBe('Test App')
    expect(body.transports).toEqual([
      { type: 'websocket', url: 'ws://localhost:4000/bellhop/socket' },
      { type: 'http', url: 'http://localhost:4000/bellhop' },
    ])
  })

  it('is single use', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })

    expect((await claim(bellhop, claimToken)).status).toBe(200)
    expect((await claim(bellhop, claimToken)).status).toBe(404)
  })

  it('answers an unknown, used, or expired token identically', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const unknown = await claim(bellhop, 'nonsense')
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ error: { code: 'claim_expired' } })
  })

  it('expires', async () => {
    const { bellhop } = testBellhop({ claimTtlMs: -1 })
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Stale' })
    expect((await claim(bellhop, claimToken)).status).toBe(404)
  })

  it('leaves the claim token valid when activation fails', async () => {
    // PAIRING.md §3: consuming first strands a human at a desk with a dead link.
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })

    licensing.state.failActivation = { code: 'payment_required', status: 402 }
    const failed = await claim(bellhop, claimToken)
    expect(failed.status).toBe(502)
    expect((failed.body as { error: { message: string } }).error.message).toMatch(
      /plan needs attention/
    )

    // The same link works once the problem is fixed.
    licensing.state.failActivation = null
    expect((await claim(bellhop, claimToken)).status).toBe(200)
  })

  it('rotates the token when an agent is re-paired', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const created = await bellhop.agents.create({ label: 'Desk' })
    const first = (await claim(bellhop, created.claimToken)).body as { agent_token: string }

    const again = await bellhop.agents.repair(created.agent.id)
    const second = (await claim(bellhop, again.claimToken)).body as { agent_token: string }

    expect(second.agent_token).not.toBe(first.agent_token)
    expect(await bellhop.authenticate(`Bearer ${first.agent_token}`)).toBeNull()
    expect(await bellhop.authenticate(`Bearer ${second.agent_token}`)).not.toBeNull()
  })

  it('rate limits by ip', async () => {
    const { bellhop } = testBellhop({ claimRateLimit: { max: 3, windowMs: 60_000 } })
    open.push(bellhop)

    for (let i = 0; i < 3; i++) expect((await claim(bellhop, 'x')).status).toBe(404)
    expect((await claim(bellhop, 'x')).status).toBe(429)
    // A different caller is unaffected.
    expect((await claim(bellhop, 'x', '10.0.0.2')).status).toBe(404)
  })

  it('never puts the claim token in the pairing link twice or logs it', async () => {
    const logged: string[] = []
    const { bellhop } = testBellhop({
      logger: { info: (m, c) => logged.push(`${m} ${JSON.stringify(c ?? {})}`) },
    })
    open.push(bellhop)

    const { claimToken, pairingLink } = await bellhop.agents.create({ label: 'Desk' })
    expect(pairingLink).toContain(encodeURIComponent(claimToken))
    expect(logged.join('\n')).not.toContain(claimToken)
  })
})

describe('agents', () => {
  it('sends an Idempotency-Key on create, and only when one is given', async () => {
    // Without it, a create that times out after bellhop.dev accepted it leaves
    // a second agent behind, holding a plan slot nothing on this side knows of.
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)

    await bellhop.agents.create({ label: 'Desk' })
    await bellhop.agents.create({ label: 'Desk', idempotencyKey: 'admin-form-9f2a' })

    expect(licensing.state.createHeaders).toHaveLength(2)
    expect(licensing.state.createHeaders[0]).not.toHaveProperty('idempotency-key')
    expect(licensing.state.createHeaders[1]!['idempotency-key']).toBe('admin-form-9f2a')
  })

  it('frees the plan slot when removed', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const { agent } = await bellhop.agents.create({ label: 'Desk' })

    await bellhop.agents.remove(agent.id)
    expect(licensing.state.deactivations).toBe(1)
    expect(await bellhop.agents.get(agent.id)).toBeNull()
  })

  it('renews credentials that expire soon and keeps the old one on failure', async () => {
    const { bellhop, licensing } = testBellhop()
    open.push(bellhop)
    const created = await bellhop.agents.create({ label: 'Desk' })
    await claim(bellhop, created.claimToken)

    // Nothing is due yet.
    expect((await bellhop.renew()).renewed).toEqual([])

    await bellhop.store.updateAgent(created.agent.id, {
      credentialExpiresAt: Date.now() + 5 * 24 * 60 * 60 * 1000,
    })
    const result = await bellhop.renew()
    expect(result.renewed).toEqual([created.agent.id])
    expect(licensing.state.renewals).toBe(1)
  })
})
