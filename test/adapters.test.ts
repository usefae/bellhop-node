/**
 * The three HTTP adapters, each driven end to end: claim, open a session,
 * poll, ack, the webhook, and a delete.
 */

import type { Server } from 'node:http'
import express from 'express'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { bellhopExpress } from '../src/adapters/express.js'
import { bellhopFastify } from '../src/adapters/fastify.js'
import { bellhopFetch } from '../src/adapters/web.js'
import { HELLO, testBellhop } from './helpers.js'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function ready(server: Server): Promise<string> {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

const PAYLOAD = { event: 'app.entitlements_changed', app: 'bh_pk_test' }

describe('the Express adapter', () => {
  it('serves every route under basePath and leaves the rest to the app', async () => {
    const { bellhop, licensing } = testBellhop()
    cleanup.push(() => bellhop.close())
    const app = express()
    app.use(bellhopExpress(bellhop))
    app.get('/other', (_req, res) => {
      res.send('ok')
    })
    const base = await ready(app.listen(0, '127.0.0.1'))
    const json = { 'content-type': 'application/json' }

    const { agent, claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const claim = await fetch(`${base}/bellhop/claim`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ claim_token: claimToken }),
    })
    expect(claim.status).toBe(200)
    const { agent_token } = (await claim.json()) as { agent_token: string }
    const headers = { ...json, authorization: `Bearer ${agent_token}` }

    expect(
      (await fetch(`${base}/bellhop/sessions`, { method: 'POST', headers: json })).status
    ).toBe(401)

    const opened = await fetch(`${base}/bellhop/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(HELLO),
    })
    expect(opened.status).toBe(201)
    const { session_id, message } = (await opened.json()) as {
      session_id: string
      message: { type: string }
    }
    expect(message.type).toBe('ready')

    const job = await bellhop.print(agent.id, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    const poll = await fetch(`${base}/bellhop/sessions/${session_id}/messages?wait=0`, { headers })
    const { messages } = (await poll.json()) as { messages: { type: string; id?: string }[] }
    expect(messages.some((m) => m.type === 'print' && m.id === job.id)).toBe(true)

    const acked = await fetch(`${base}/bellhop/sessions/${session_id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ type: 'ack', id: job.id, status: 'printed' }] }),
    })
    expect(acked.status).toBe(200)
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')

    const webhook = await fetch(`${base}/bellhop/webhook`, {
      method: 'POST',
      headers: { ...json, 'bellhop-signature': licensing.signWebhook() },
      body: JSON.stringify(PAYLOAD),
    })
    expect(webhook.status).toBe(202)

    const deleted = await fetch(`${base}/bellhop/sessions/${session_id}`, {
      method: 'DELETE',
      headers,
    })
    expect(deleted.status).toBe(200)

    // Paths the library does not own fall through to the application.
    const other = await fetch(`${base}/other`)
    expect(await other.text()).toBe('ok')
    const unknown = await fetch(`${base}/bellhop/nope`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).not.toContain('json')
  })
})

describe('the Fastify adapter', () => {
  it('registers as a named plugin and honours a custom basePath', async () => {
    const { bellhop, licensing } = testBellhop({ basePath: '/api/print' })
    cleanup.push(() => bellhop.close())
    const app = Fastify()
    await app.register(bellhopFastify, { bellhop })
    cleanup.push(() => app.close())
    expect(app.hasPlugin('@usefae/bellhop-node')).toBe(true)

    const { agent, claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const claim = await app.inject({
      method: 'POST',
      url: '/api/print/claim',
      payload: { claim_token: claimToken },
    })
    expect(claim.statusCode).toBe(200)
    const headers = { authorization: `Bearer ${claim.json<{ agent_token: string }>().agent_token}` }

    const opened = await app.inject({
      method: 'POST',
      url: '/api/print/sessions',
      headers,
      payload: HELLO,
    })
    expect(opened.statusCode).toBe(201)
    const sessionId = opened.json<{ session_id: string }>().session_id

    const job = await bellhop.print(agent.id, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    const poll = await app.inject({
      method: 'GET',
      url: `/api/print/sessions/${sessionId}/messages?wait=0`,
      headers,
    })
    const { messages } = poll.json<{ messages: { type: string; id?: string }[] }>()
    expect(messages.some((m) => m.type === 'print' && m.id === job.id)).toBe(true)

    const webhook = await app.inject({
      method: 'POST',
      url: '/api/print/webhook',
      headers: { 'bellhop-signature': licensing.signWebhook() },
      payload: PAYLOAD,
    })
    expect(webhook.statusCode).toBe(202)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/print/sessions/${sessionId}`,
      headers,
    })
    expect(deleted.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/print/nope' })).statusCode).toBe(404)
  })
})

describe('the fetch adapter', () => {
  const claimFrom = (handle: (request: Request) => Promise<Response>, ip?: string) =>
    handle(
      new Request('http://deliver.example.com/bellhop/claim', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {}),
        },
        body: JSON.stringify({ claim_token: 'nope' }),
      })
    )

  it('handles a Request, slices basePath, and limits by the forwarded address', async () => {
    const { bellhop } = testBellhop({ claimRateLimit: { max: 1, windowMs: 60_000 } })
    cleanup.push(() => bellhop.close())
    const handle = bellhopFetch(bellhop)

    const first = await claimFrom(handle, '203.0.113.7')
    expect(first.status).toBe(404)
    expect(first.headers.get('content-type')).toBe('application/json')
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe('claim_expired')

    // A second attempt from the same forwarded address is limited; another address is not.
    expect((await claimFrom(handle, '203.0.113.7')).status).toBe(429)
    expect((await claimFrom(handle, '203.0.113.8')).status).toBe(404)

    expect((await handle(new Request('http://deliver.example.com/health'))).status).toBe(404)
  })

  it('turns the limiter off, with one warning, when no address is available', async () => {
    const warnings: string[] = []
    const { bellhop } = testBellhop({
      claimRateLimit: { max: 1, windowMs: 60_000 },
      logger: { warn: (message) => warnings.push(message) },
    })
    cleanup.push(() => bellhop.close())
    const handle = bellhopFetch(bellhop)

    expect((await claimFrom(handle)).status).toBe(404)
    expect((await claimFrom(handle)).status).toBe(404)
    expect(warnings.filter((w) => w.includes('rate limiting is off'))).toHaveLength(1)
  })
})
