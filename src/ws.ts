/**
 * The WebSocket transport (TRANSPORTS.md §2). Its own entry point, so a
 * deployment on the HTTP transport alone never pulls `ws` in.
 *
 *   import { attachWebSocket } from '@usefae/bellhop-node/ws'
 *   const server = app.listen(3000)
 *   attachWebSocket(bellhop, server)
 */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Bellhop } from './bellhop.js'
import type { Connection } from './connections.js'
import type { AgentMessage, CloseCode, CloseMessage, ServerMessage } from './types.js'
import { PROTOCOL_VERSION } from './types.js'

/** Document bytes never travel agent to server, so a frame this large is a fault. */
const MAX_PAYLOAD = 1024 * 1024

class SocketConnection implements Connection {
  handshakeComplete = false
  private isOpen = true

  constructor(
    private readonly socket: WebSocket,
    readonly agentId: string
  ) {}

  get open(): boolean {
    return this.isOpen && this.socket.readyState === this.socket.OPEN
  }

  send(message: ServerMessage): void {
    if (!this.open) return
    // One JSON object per text frame. Document bytes travel base64 in `data`,
    // never as binary frames.
    this.socket.send(JSON.stringify(message))
  }

  close(code: CloseCode, reason = '', retryAfterSeconds?: number): void {
    if (!this.isOpen) return
    // The advisory costs one frame and survives frameworks and proxies that
    // rewrite close codes. A retry hint always rides it, since the close frame
    // has no room for one (PROTOCOL.md §7.2).
    if (code >= 4000 || retryAfterSeconds != null) {
      const advisory: CloseMessage = { type: 'close', code, reason }
      if (retryAfterSeconds != null) advisory.retry_after_seconds = retryAfterSeconds
      this.send(advisory)
    }
    this.isOpen = false
    // RFC 6455 caps a close reason at 123 bytes.
    this.socket.close(code, reason.slice(0, 120))
  }

  terminate(): void {
    this.isOpen = false
    this.socket.terminate()
  }
}

export interface AttachOptions {
  /** Defaults to `${basePath}/socket`, which is where agents look. */
  path?: string
}

/**
 * Handle WebSocket upgrades for this Bellhop instance. Authentication happens
 * at upgrade time, from the `Authorization` header, and a failure is refused
 * with an HTTP status before the handshake completes. That is what makes
 * unpairing take effect at once. Returns a function that stops handling
 * upgrades.
 */
export function attachWebSocket(
  bellhop: Bellhop,
  server: Server,
  options: AttachOptions = {}
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
  const path = options.path ?? `${bellhop.config.basePath}/socket`
  bellhop.autoStartRenewals()

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // ws attaches its own listener once handleUpgrade runs. Until then, a
    // reset from the peer during the token lookup would be an uncaught
    // exception.
    socket.on('error', () => socket.destroy())
    handleUpgrade(bellhop, wss, path, request, socket, head).catch((error: Error) => {
      bellhop.reportError(error)
      refuse(socket, 500, 'Internal Server Error')
    })
  }

  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    wss.close()
  }
}

async function handleUpgrade(
  bellhop: Bellhop,
  wss: WebSocketServer,
  path: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (url.pathname !== path) return

  // The agent is a native application and sends no Origin header. None may be
  // required (PROTOCOL.md §9).
  const agent = await bellhop.authenticate(request.headers.authorization)
  if (!agent) return refuse(socket, 401, 'Unauthorized')

  // The agent repeats its protocol version in a header so an unsupported one
  // can be refused before the handshake.
  const declared = Number(request.headers['bellhop-protocol-version'])
  if (declared && declared !== PROTOCOL_VERSION) return refuse(socket, 426, 'Upgrade Required')

  wss.handleUpgrade(request, socket, head, (ws) => {
    const connection = new SocketConnection(ws, agent.id)

    // A socket that never says hello is not in the registry, so the reaper
    // never sees it. Give it the same allowance and then drop it.
    const helloTimer = setTimeout(
      () => {
        if (!connection.handshakeComplete) connection.terminate()
      },
      bellhop.config.heartbeatSeconds * 3 * 1000
    )
    helloTimer.unref?.()

    ws.on('message', (raw: Buffer) => {
      let message: AgentMessage
      try {
        message = JSON.parse(raw.toString('utf8')) as AgentMessage
      } catch {
        return // a malformed frame is dropped
      }
      bellhop.receive(connection, message).catch((error: Error) => bellhop.reportError(error))
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      bellhop.releaseConnection(connection)
    })
    ws.on('error', () => bellhop.releaseConnection(connection))
  })
}

function refuse(socket: Duplex, status: number, text: string): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  socket.once('finish', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
