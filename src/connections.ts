/**
 * One live connection per agent, whichever transport it arrived on, plus the
 * seam that lets another process reach a socket this one does not hold.
 */

import type { CloseCode, ServerMessage } from './types.js'

/** What both transports look like from above. */
export interface Connection {
  readonly agentId: string
  readonly open: boolean
  /**
   * False until the first `hello` on this connection. Only a handshake
   * redelivers outstanding jobs; see `session.ts`.
   */
  handshakeComplete: boolean
  send(message: ServerMessage): void
  close(code: CloseCode, reason?: string, retryAfterSeconds?: number): void
  /** Drop the transport at once, with no close frame. For a connection that has gone quiet. */
  terminate?(): void
}

/**
 * Cross-process fanout. A print job is usually created by a different process
 * from the one holding the agent's socket (TRANSPORTS.md §2.4). The default is
 * in-process and complete for a single process. For more than one, publish
 * over Redis and call `deliver` on every subscriber; whichever process holds
 * the connection writes to it and the rest no-op.
 *
 *   const redis = new Redis(url), sub = redis.duplicate()
 *   const pubsub: PubSub = {
 *     publish: (agentId, message) =>
 *       redis.publish('bellhop', JSON.stringify({ agentId, message })),
 *     subscribe(deliver) {
 *       sub.subscribe('bellhop')
 *       sub.on('message', (_, raw) => {
 *         const { agentId, message } = JSON.parse(raw)
 *         deliver(agentId, message)
 *       })
 *     },
 *     close: () => Promise.all([redis.quit(), sub.quit()]),
 *   }
 */
export interface PubSub {
  publish(agentId: string, message: ServerMessage): void | Promise<void>
  subscribe(deliver: (agentId: string, message: ServerMessage) => void): void
  /** Called by `bellhop.close()`. */
  close?(): void | Promise<void>
}

/**
 * How "is this agent online?" is answered. The registry only knows sockets
 * held by this process, so across processes the answer needs shared state. The
 * default derives it from the store's `lastSeenAt`, which every process
 * already writes and a crashed process cannot leave stale. Provide your own
 * (Redis, say) if a store read per check is too hot.
 */
export interface Presence {
  isOnline(agentId: string): Promise<boolean>
  onlineIds(): Promise<string[]>
  /** Called by `bellhop.close()`. */
  close?(): void | Promise<void>
}

/** The default. One process, no broker. */
export function inProcessPubSub(): PubSub {
  let handler: ((agentId: string, message: ServerMessage) => void) | null = null
  return {
    publish(agentId, message) {
      handler?.(agentId, message)
    },
    subscribe(deliver) {
      handler = deliver
    },
  }
}

export class Registry {
  private readonly byAgent = new Map<string, Connection>()

  constructor(private readonly onPresenceChange: (agentId: string, online: boolean) => void) {}

  get(agentId: string): Connection | null {
    return this.byAgent.get(agentId) ?? null
  }

  isOnline(agentId: string): boolean {
    return Boolean(this.byAgent.get(agentId)?.open)
  }

  get onlineIds(): string[] {
    return [...this.byAgent.entries()].filter(([, c]) => c.open).map(([id]) => id)
  }

  connections(): Connection[] {
    return [...this.byAgent.values()]
  }

  /**
   * Register a connection, displacing any older one for the same agent. The
   * older one is closed with 4004, which the agent treats as retryable
   * (PROTOCOL.md §2.1).
   */
  register(connection: Connection): void {
    const existing = this.byAgent.get(connection.agentId)
    if (existing && existing !== connection && existing.open) {
      existing.close(4004, 'Replaced by a newer session.')
    }
    const wasOnline = Boolean(existing?.open)
    this.byAgent.set(connection.agentId, connection)
    if (!wasOnline) this.onPresenceChange(connection.agentId, true)
  }

  /** No-op when a newer connection has already taken over. */
  unregister(connection: Connection): void {
    if (this.byAgent.get(connection.agentId) !== connection) return
    this.byAgent.delete(connection.agentId)
    this.onPresenceChange(connection.agentId, false)
  }

  /**
   * Close whatever is live for an agent. Without this, a machine holding a
   * rotated token keeps printing until it happens to reconnect (PAIRING.md §4).
   */
  close(agentId: string, code: CloseCode, reason: string, retryAfterSeconds?: number): void {
    this.byAgent.get(agentId)?.close(code, reason, retryAfterSeconds)
  }

  closeAll(code: CloseCode, reason: string, retryAfterSeconds?: number): void {
    for (const connection of [...this.byAgent.values()]) {
      connection.close(code, reason, retryAfterSeconds)
    }
  }
}
