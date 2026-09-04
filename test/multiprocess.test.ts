/**
 * Two Bellhop instances sharing one store and one pubsub broker: the shape of
 * a horizontally scaled deployment, where the process that creates a print job
 * is not the process holding the agent's connection (TRANSPORTS.md §2.4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeAgent } from '../src/testing/index.js'
import { memoryStore } from '../src/store/memory.js'
import type { PubSub, Presence } from '../src/connections.js'
import type { ServerMessage } from '../src/types.js'
import { HELLO, httpAgent, messagesOf, testBellhop } from './helpers.js'
import type { Bellhop } from '../src/bellhop.js'

let open: Bellhop[] = []

afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

/** A stand-in for Redis: every endpoint's publish reaches every subscriber. */
function broker() {
  const handlers: Array<(agentId: string, message: ServerMessage) => void> = []
  return {
    endpoint(): PubSub {
      return {
        publish(agentId, message) {
          for (const handler of handlers) handler(agentId, structuredClone(message))
        },
        subscribe(deliver) {
          handlers.push(deliver)
        },
      }
    },
  }
}

/** A web worker and a connection-holder, as a load balancer would split them. */
function cluster() {
  const store = memoryStore()
  const bus = broker()
  const { bellhop: web } = testBellhop({ store, pubsub: bus.endpoint() })
  const { bellhop: holder } = testBellhop({ store, pubsub: bus.endpoint() })
  open.push(web, holder)
  return { web, holder, store }
}

describe('across processes', () => {
  it('a print created on one process reaches a socket held by another', async () => {
    const { web, holder } = cluster()
    const { claimToken } = await web.agents.create({ label: 'Shipping Desk' })
    const agent = await fakeAgent(holder, { claimToken })

    const job = await web.print(agent.agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    await agent.waitForPrint()

    expect(agent.printed).toHaveLength(1)
    // The process that wrote to the live connection marked it sent; the fake
    // agent then acked, so the terminal state proves the whole loop.
    await vi.waitFor(async () => expect((await web.jobs.get(job.id))!.status).toBe('printed'))
  })

  it('presence answers from shared state, not the local socket map', async () => {
    const { web, holder } = cluster()
    const { claimToken } = await web.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(holder, { claimToken })

    // The web worker holds no socket for this agent, and knows it is online.
    expect(await web.agents.isOnline(agent.agentId)).toBe(true)
    expect(await web.agents.onlineIds()).toContain(agent.agentId)
  })

  it('a custom Presence seam overrides the default', async () => {
    const nobody: Presence = {
      isOnline: async () => false,
      onlineIds: async () => [],
    }
    const { bellhop } = testBellhop({ presence: nobody })
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })

    expect(await bellhop.agents.isOnline(agent.agentId)).toBe(false)
  })

  it('an HTTP session opened on one process serves polls and deliveries on another', async () => {
    const { web, holder } = cluster()
    const { agent, claimToken } = await web.agents.create({ label: 'Proxy Desk' })

    // Pair and open the session through the holder, as the balancer might.
    const session = await httpAgent(holder, claimToken)
    expect(session.opened.status).toBe(201)

    // The web worker creates the job. No pubsub is involved for this
    // transport: the queue in the store is the fanout mechanism.
    const job = await web.print(agent.id, {
      kind: 'label',
      format: 'zpl',
      data: '^XA^FDcross^FS^XZ',
    })
    expect((await web.jobs.get(job.id))!.status).toBe('sent')

    // The web process, which never saw the session open, serves the poll, as
    // a non-sticky balancer would route it.
    const poll = await session.poll(web, 0)
    expect(poll.status).toBe(200)
    expect(messagesOf(poll).some((m) => m.type === 'print' && m.id === job.id)).toBe(true)

    // Drained means drained: the holder does not see it again.
    expect(messagesOf(await session.poll(holder, 0))).toEqual([])
  })

  it('a poll with no wait is held, and an explicit wait=0 is not', async () => {
    const { bellhop } = testBellhop({ pollSeconds: 1 })
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const session = await httpAgent(bellhop, claimToken)

    const immediate = await session.poll(bellhop, 0)
    expect(messagesOf(immediate)).toEqual([])

    const held = session.poll(bellhop)
    const winner = await Promise.race([
      held.then(() => 'poll'),
      new Promise((resolve) => setTimeout(() => resolve('timer'), 50)),
    ])
    expect(winner).toBe('timer')
    await bellhop.close()
    await held
  })

  it('a mid-session hello on a foreign process is not mistaken for a handshake', async () => {
    const { web, holder } = cluster()
    const { agent, claimToken } = await web.agents.create({ label: 'Desk' })
    const session = await httpAgent(holder, claimToken)

    // A job printed and outstanding (unacked, so a fresh handshake would
    // re-flush it).
    const job = await web.print(agent.id, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    expect(messagesOf(await session.poll(holder, 0)).some((m) => m.id === job.id)).toBe(true)

    // The operator toggles a setting and the fresh hello lands on the web
    // worker. Only a handshake redelivers, so this must not re-send the job.
    const rehello = await session.post([HELLO], web)
    expect(messagesOf(rehello).filter((m) => m.type === 'print')).toEqual([])
  })
})
