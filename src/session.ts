/**
 * The protocol, independent of transport. Both transports hand their messages
 * here (PROTOCOL.md, design rule 3).
 */

import type { Connection } from './connections.js'
import type { AckErrorCode, AgentMessage, HelloMessage, Printer } from './types.js'
import { PROTOCOL_VERSION } from './types.js'
import type { AgentRecord } from './store/types.js'

export interface SessionHost {
  readonly appName: string | undefined
  readonly accentColor: string | undefined
  readonly heartbeatSeconds: number
  touch(agentId: string): Promise<void>
  storeHello(agentId: string, hello: HelloMessage): Promise<AgentRecord>
  registerConnection(connection: Connection): void | Promise<void>
  flushOutstanding(agentId: string): Promise<void>
  recordAck(
    agent: AgentRecord,
    id: string,
    status: 'printed' | 'failed',
    error: string | null,
    errorCode: AckErrorCode | null
  ): Promise<void>
  emit(event: string, payload: unknown): void
  log(level: 'info' | 'warn' | 'error', message: string, context?: unknown): void
}

/**
 * The printer inventory of a `hello`, read defensively and never rejected. An
 * entry without a usable `id` is dropped; unknown fields are carried through
 * (design rule 4).
 */
export function readPrinters(value: unknown): Printer[] {
  if (!Array.isArray(value)) return []
  const printers: Printer[] = []
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const printer = entry as Partial<Printer>
    if (typeof printer.id !== 'string' || printer.id.length === 0) continue
    printers.push({
      ...printer,
      id: printer.id,
      name: typeof printer.name === 'string' ? printer.name : printer.id,
      capabilities:
        printer.capabilities && typeof printer.capabilities === 'object'
          ? printer.capabilities
          : {},
    })
  }
  return printers
}

/** Role to printer id. Anything that is not a pair of strings is not a role. */
export function readDefaultPrinters(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const roles: Record<string, string> = {}
  for (const [role, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === 'string' && id.length > 0) roles[role] = id
  }
  return roles
}

export async function handleAgentMessage(
  host: SessionHost,
  agent: AgentRecord,
  connection: Connection,
  message: AgentMessage
): Promise<void> {
  // Any message is proof of life.
  await host.touch(agent.id)

  switch (message?.type) {
    case 'hello':
      return handleHello(host, agent, connection, message)

    case 'ack': {
      if (typeof message.id !== 'string') return
      const status = message.status === 'printed' ? 'printed' : 'failed'
      // An unfamiliar error_code means a plain failure (PROTOCOL.md §4.2).
      await host.recordAck(
        agent,
        message.id,
        status,
        message.error ?? null,
        message.error_code ?? null
      )
      return
    }

    case 'weight':
      // Already filtered by the agent. Do not debounce again.
      host.emit('weight', {
        agentId: agent.id,
        grams: message.grams,
        stable: message.stable !== false,
      })
      return

    case 'event':
      host.emit('event', {
        agentId: agent.id,
        code: message.code,
        message: message.message ?? null,
        at: message.at ?? null,
      })
      return

    case 'ping':
      // Skip this and every agent drops and reconnects every 35 seconds
      // (PROTOCOL.md §6).
      connection.send({ type: 'pong', token: message.token })
      return

    case 'pong':
      return

    default:
      // Design rule 4: ignore what you do not recognise, and never close the
      // session over it.
      return
  }
}

async function handleHello(
  host: SessionHost,
  agent: AgentRecord,
  connection: Connection,
  message: HelloMessage
): Promise<void> {
  if (message.protocol_version !== PROTOCOL_VERSION) {
    host.log('warn', `agent ${agent.id} speaks protocol version ${message.protocol_version}`)
    // Terminal. Telling the operator to update beats guessing.
    connection.close(4002, `This server speaks protocol version ${PROTOCOL_VERSION}.`)
    return
  }

  // A hello also arrives mid-session whenever the operator changes something.
  // Only the first one on a connection is a handshake, and only a handshake
  // redelivers.
  const isHandshake = !connection.handshakeComplete
  connection.handshakeComplete = true

  // A later hello replaces the earlier one wholesale.
  const updated = await host.storeHello(agent.id, message)
  await host.registerConnection(connection)

  host.emit('hello', {
    agentId: agent.id,
    agentVersion: message.agent_version,
    platform: message.platform,
    capabilities: message.capabilities ?? [],
    printers: readPrinters(message.printers),
    defaultPrinters: readDefaultPrinters(message.default_printers),
    isHandshake,
  })

  connection.send({
    type: 'ready',
    protocol_version: PROTOCOL_VERSION,
    // Branding from activation, falling back to local configuration.
    app_name: updated.appName ?? host.appName,
    accent_color: updated.accentColor ?? host.accentColor ?? null,
    // Always send the credential. The agent adopts a renewed one on its next
    // reconnect this way, with nobody touching the machine (PROTOCOL.md §5.1).
    credential: updated.credential,
    heartbeat_seconds: host.heartbeatSeconds,
  })

  // Redelivery belongs to the handshake, not to every hello. A mid-session
  // hello changes nothing about which jobs are outstanding, and re-sending
  // them before the agent's ledger has recorded the first delivery prints
  // duplicate labels. A reconnect is a new connection, so it is a handshake
  // and still flushes everything.
  if (isHandshake) await host.flushOutstanding(agent.id)
}
