/**
 * A Bellhop agent that exists only in your test process. Printing to a real
 * agent is the right way to check that a label comes out; this is for CI,
 * where no agent exists.
 *
 *   import { fakeAgent } from '@usefae/bellhop-node/testing'
 *
 *   const agent = await fakeAgent(bellhop, { claimToken })
 *   await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: zpl })
 *   await agent.waitForPrint()
 *   expect(agent.printed).toHaveLength(1)
 *   await agent.close()
 *
 * It speaks the protocol the way the real agent does: it deduplicates by job
 * id, answers `ping`, and re-sends the original ack for a job it has already
 * completed.
 */

import type { Bellhop } from '../bellhop.js'
import type { Connection } from '../connections.js'
import type {
  AckMessage,
  AgentMessage,
  Capability,
  CloseCode,
  Printer,
  PrintMessage,
  PrintOptions,
  ServerMessage,
} from '../types.js'
import { PROTOCOL_VERSION } from '../types.js'

export { fakeLicensing } from './licensing.js'
export type { FakeLicensing, FakeLicensingState } from './licensing.js'

/**
 * A label printer and a document printer. Override `printers` for other
 * shapes: two label printers, a queue whose driver could not be read
 * (`capabilities: {}`), or a desk that shares nothing.
 */
const DEFAULT_PRINTERS: Printer[] = [
  {
    id: 'Fake_ZP450',
    name: 'Fake ZP450',
    capabilities: {
      papers: ['w288h432', 'w288h360'],
      default_paper: 'w288h432',
      dpi: [203],
      default_dpi: 203,
      duplex: false,
      color: false,
    },
  },
  {
    id: 'Fake_LaserJet',
    name: 'Fake LaserJet',
    capabilities: {
      papers: ['Letter', 'Legal', 'A4'],
      default_paper: 'Letter',
      bins: ['Auto', 'Tray1', 'Tray2'],
      default_bin: 'Auto',
      dpi: [600, 1200],
      default_dpi: 600,
      duplex: true,
      color: true,
    },
  },
]

const DEFAULT_ROLES: Record<string, string> = {
  label: 'Fake_ZP450',
  document: 'Fake_LaserJet',
}

export interface FakeAgentOptions {
  /** From `bellhop.agents.create()`. Redeemed as a real agent would. */
  claimToken: string
  capabilities?: Capability[]
  agentVersion?: string
  platform?: 'macos' | 'windows' | 'linux'
  /** The printers this agent has shared, and what each can do. */
  printers?: Printer[]
  /** Role to printer id: where a job that names no printer goes. */
  defaultPrinters?: Record<string, string>
  /** Fail every print, to exercise your error path. */
  failPrints?: boolean
  /** Answer `ready` with another `hello`, as a misbehaving agent would. */
  rehelloOnReady?: boolean
}

export interface PrintedJob {
  id: string
  kind: string
  format: string
  /** The printer the job named, or null when it routed by format. */
  printer: string | null
  /** The options the job carried, or null when it carried none. */
  options: PrintOptions | null
  /** Decoded bytes when the job was inline, null when it came by url. */
  data: Buffer | null
  url: string | null
}

export interface FakeAgent {
  readonly agentId: string
  /** Every job printed, after deduplication. */
  readonly printed: PrintedJob[]
  /** Every `print` message received, duplicates included. */
  readonly received: PrintMessage[]
  readonly messages: ServerMessage[]
  /** Resolves once `printed.length` reaches `count`. */
  waitForPrint(count?: number, timeoutMs?: number): Promise<PrintedJob>
  /** Resolves with the ack sent for `jobId`, or for the next job acked when omitted. Failed prints ack too. */
  waitForAck(jobId?: string, timeoutMs?: number): Promise<AckMessage>
  /** Send a fresh `hello`, as the agent does when the operator changes a setting. */
  sendHello(
    overrides?: Partial<{
      capabilities: Capability[]
      printers: Printer[]
      defaultPrinters: Record<string, string>
    }>
  ): Promise<void>
  ping(): Promise<void>
  weigh(grams: number): Promise<void>
  emit(message: AgentMessage): Promise<void>
  close(): Promise<void>
}

/**
 * Claim an agent and hold an in-process session against it. No sockets and no
 * HTTP: this talks to the protocol layer directly.
 */
export async function fakeAgent(bellhop: Bellhop, options: FakeAgentOptions): Promise<FakeAgent> {
  const claim = await bellhop.handleRequest({
    method: 'POST',
    path: '/claim',
    getHeader: () => undefined,
    body: { claim_token: options.claimToken },
    ip: '127.0.0.1',
  })

  if (claim.status !== 200) {
    throw new Error(`fakeAgent could not claim: ${JSON.stringify(claim.body)}`)
  }

  const record = await findAgentByToken(
    bellhop,
    (claim.body as { agent_token: string }).agent_token
  )

  const capabilities = options.capabilities ?? [
    'print:zpl',
    'print:raw',
    'print:pdf',
    'print:gif',
    'scale',
  ]
  const printed: PrintedJob[] = []
  const received: PrintMessage[] = []
  const messages: ServerMessage[] = []
  // The real agent keeps a ledger of completed job ids and answers a
  // duplicate with the original ack.
  const ledger = new Map<string, AckMessage>()
  const ackWaiters: {
    jobId: string | undefined
    resolve: (ack: AckMessage) => void
    timer: NodeJS.Timeout
  }[] = []
  const waiters: { count: number; resolve: (job: PrintedJob) => void; timer: NodeJS.Timeout }[] = []
  let sessions = 0

  const connection: Connection & { closed: boolean } = {
    agentId: record.id,
    closed: false,
    handshakeComplete: false,
    get open() {
      return !this.closed
    },
    send(message: ServerMessage) {
      messages.push(message)
      void handle(message)
    },
    close(_code: CloseCode) {
      this.closed = true
    },
  }

  const send = (message: AgentMessage): Promise<void> => bellhop.receive(connection, message)

  async function handle(message: ServerMessage): Promise<void> {
    if (message.type === 'ready' && options.rehelloOnReady) {
      await agent.sendHello()
      return
    }
    if (message.type === 'ping') {
      await send({ type: 'pong', token: message.token })
      return
    }
    if (message.type !== 'print') return

    received.push(message)

    const already = ledger.get(message.id)
    if (already) {
      // Never print twice.
      await send(already)
      return
    }

    const ack: AckMessage = options.failPrints
      ? { type: 'ack', id: message.id, status: 'failed', error: 'fakeAgent was told to fail' }
      : { type: 'ack', id: message.id, status: 'printed', error: null }

    ledger.set(message.id, ack)
    for (const waiter of [...ackWaiters]) {
      if (waiter.jobId === undefined || waiter.jobId === message.id) {
        clearTimeout(waiter.timer)
        ackWaiters.splice(ackWaiters.indexOf(waiter), 1)
        waiter.resolve(ack)
      }
    }

    if (!options.failPrints) {
      const job: PrintedJob = {
        id: message.id,
        kind: message.kind,
        format: message.format,
        printer: message.printer ?? null,
        options: message.options ?? null,
        data: message.data ? Buffer.from(message.data, 'base64') : null,
        url: message.url ?? null,
      }
      printed.push(job)
      for (const waiter of [...waiters]) {
        if (printed.length >= waiter.count) {
          clearTimeout(waiter.timer)
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.resolve(job)
        }
      }
    }

    await send(ack)
  }

  const agent: FakeAgent = {
    agentId: record.id,
    printed,
    received,
    messages,

    async sendHello(overrides = {}) {
      await send({
        type: 'hello',
        protocol_version: PROTOCOL_VERSION,
        agent_version: options.agentVersion ?? '1.0.0-fake',
        platform: options.platform ?? 'macos',
        session_id: `fake-${++sessions}`,
        capabilities: overrides.capabilities ?? capabilities,
        printers: overrides.printers ?? options.printers ?? DEFAULT_PRINTERS,
        default_printers:
          overrides.defaultPrinters ??
          options.defaultPrinters ??
          defaultRolesFor(overrides.printers ?? options.printers),
      })
    },

    ping: () => send({ type: 'ping', token: 'fake' }),
    weigh: (grams: number) => send({ type: 'weight', grams, stable: true }),
    emit: (message: AgentMessage) => send(message),

    waitForPrint(count = 1, timeoutMs = 2_000) {
      const existing = printed[count - 1]
      if (existing) return Promise.resolve(existing)
      return new Promise<PrintedJob>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`fakeAgent waited ${timeoutMs}ms for print #${count}`)),
          timeoutMs
        )
        timer.unref?.()
        waiters.push({ count, resolve, timer })
      })
    },

    waitForAck(jobId, timeoutMs = 2_000) {
      const already = jobId === undefined ? undefined : ledger.get(jobId)
      if (already) return Promise.resolve(already)
      return new Promise<AckMessage>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `fakeAgent waited ${timeoutMs}ms for an ack${jobId ? ` of job ${jobId}` : ''}`
              )
            ),
          timeoutMs
        )
        timer.unref?.()
        ackWaiters.push({ jobId, resolve, timer })
      })
    },

    async close() {
      connection.closed = true
      bellhop.releaseConnection(connection)
      for (const waiter of waiters) clearTimeout(waiter.timer)
      for (const waiter of ackWaiters) clearTimeout(waiter.timer)
    },
  }

  await agent.sendHello()
  return agent
}

/**
 * Roles for an inventory supplied without them: both at the first printer,
 * which is what a licence capped at one printer looks like. Every role must
 * name a printer in the same hello, so the built-in roles cannot be carried
 * over to someone else's list.
 */
function defaultRolesFor(printers: Printer[] | undefined): Record<string, string> {
  if (!printers) return DEFAULT_ROLES
  const first = printers[0]
  return first ? { label: first.id, document: first.id } : {}
}

async function findAgentByToken(bellhop: Bellhop, token: string) {
  const agent = await bellhop.authenticate(`Bearer ${token}`)
  if (!agent) throw new Error('fakeAgent claimed an agent but its token did not authenticate')
  return agent
}
