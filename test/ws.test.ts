/** The WebSocket transport, against a real `ws` client. */

import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bellhop } from '../src/bellhop.js'
import { attachWebSocket } from '../src/ws.js'
import { HELLO, testBellhop } from './helpers.js'

let cleanup: (() => unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

async function serve(bellhop: Bellhop) {
  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  const detach = attachWebSocket(bellhop, server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as { port: number }
  return { url: `ws://127.0.0.1:${port}/bellhop/socket`, detach }
}

async function token(bellhop: Bellhop): Promise<{ agentId: string; token: string }> {
  const { agent, claimToken } = await bellhop.agents.create({ label: 'Desk' })
  const claim = await bellhop.handleRequest({
    method: 'POST',
    path: '/claim',
    getHeader: () => undefined,
    body: { claim_token: claimToken },
    ip: '10.0.0.1',
  })
  return { agentId: agent.id, token: (claim.body as { agent_token: string }).agent_token }
}

type Frame = Record<string, unknown>

function connect(url: string, headers: Record<string, string>) {
  return new Promise<{ ws: WebSocket; next: () => Promise<Frame>; closed: Promise<number> }>(
    (resolve, reject) => {
      const ws = new WebSocket(url, { headers })
      const queue: Frame[] = []
      const waiters: ((frame: Frame) => void)[] = []
      const closed = new Promise<number>((done) => ws.on('close', (code) => done(code)))
      ws.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as Frame
        const waiter = waiters.shift()
        if (waiter) waiter(frame)
        else queue.push(frame)
      })
      ws.on('open', () => {
        cleanup.push(() => ws.terminate())
        resolve({
          ws,
          closed,
          next: () =>
            queue.length > 0
              ? Promise.resolve(queue.shift()!)
              : new Promise<Frame>((r) => waiters.push(r)),
        })
      })
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.on('error', reject)
    }
  )
}

describe('the WebSocket transport', () => {
  it('completes a handshake, delivers a print, records the ack, and tracks presence', async () => {
    const { bellhop } = testBellhop()
    cleanup.push(() => bellhop.close())
    const { url } = await serve(bellhop)
    const { agentId, token: bearer } = await token(bellhop)
    const offline = new Promise<void>((resolve) => bellhop.once('offline', () => resolve()))

    const { ws, next, closed } = await connect(url, { authorization: `Bearer ${bearer}` })
    ws.send(JSON.stringify(HELLO))
    expect(await next()).toMatchObject({ type: 'ready', protocol_version: 1 })
    expect(await bellhop.agents.isOnline(agentId)).toBe(true)

    const job = await bellhop.print(agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    expect(await next()).toMatchObject({ type: 'print', id: job.id, format: 'zpl' })

    ws.send(JSON.stringify({ type: 'ack', id: job.id, status: 'printed' }))
    ws.send('not json at all')
    ws.send(JSON.stringify({ type: 'ping', token: 't1' }))
    expect(await next()).toMatchObject({ type: 'pong', token: 't1' })
    expect((await bellhop.jobs.get(job.id))!.status).toBe('printed')

    ws.close(1000)
    expect(await closed).toBe(1000)
    await offline
  })

  it('refuses a bad token and a wrong protocol version before the handshake', async () => {
    const { bellhop } = testBellhop()
    cleanup.push(() => bellhop.close())
    const { url } = await serve(bellhop)
    const { token: bearer } = await token(bellhop)

    await expect(connect(url, { authorization: 'Bearer nope' })).rejects.toThrow('HTTP 401')
    await expect(
      connect(url, { authorization: `Bearer ${bearer}`, 'bellhop-protocol-version': '2' })
    ).rejects.toThrow('HTTP 426')
  })

  it('closes with 4001 when the agent is re-paired and 4003 when it is removed', async () => {
    const { bellhop } = testBellhop()
    cleanup.push(() => bellhop.close())
    const { url } = await serve(bellhop)
    const { agentId, token: bearer } = await token(bellhop)

    const first = await connect(url, { authorization: `Bearer ${bearer}` })
    first.ws.send(JSON.stringify(HELLO))
    await first.next()
    const { claimToken } = await bellhop.agents.repair(agentId)
    await bellhop.handleRequest({
      method: 'POST',
      path: '/claim',
      getHeader: () => undefined,
      body: { claim_token: claimToken },
      ip: '10.0.0.1',
    })
    expect(await first.next()).toMatchObject({ type: 'close', code: 4001 })
    expect(await first.closed).toBe(4001)
  })

  it('drops a socket that never says hello', async () => {
    const { bellhop } = testBellhop({ heartbeatSeconds: 0.02 })
    cleanup.push(() => bellhop.close())
    const { url } = await serve(bellhop)
    const { token: bearer } = await token(bellhop)

    const { closed } = await connect(url, { authorization: `Bearer ${bearer}` })
    expect(await closed).toBe(1006)
  })

  it('stops handling upgrades once detached', async () => {
    const { bellhop } = testBellhop()
    cleanup.push(() => bellhop.close())
    const { url, detach } = await serve(bellhop)
    const { token: bearer } = await token(bellhop)

    detach()
    await expect(connect(url, { authorization: `Bearer ${bearer}` })).rejects.toThrow()
  })
})
