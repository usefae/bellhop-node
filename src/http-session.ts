import type { Connection } from './connections.js'
import type { CloseMessage, ServerMessage } from './types.js'

export interface HttpSessionHooks {
  enqueue(sessionId: string, messages: ServerMessage[]): Promise<void>
  drain(sessionId: string): Promise<ServerMessage[]>
  setHandshakeComplete(sessionId: string): Promise<void>
  destroy(sessionId: string): void
  onError(error: Error): void
}

/**
 * One HTTP-transport session as this process sees it. The queue lives in the
 * store, so any process can enqueue to it and serve its polls (TRANSPORTS.md
 * §2.4). This object is only the local machinery: the held-poll waiter and the
 * Connection facade the protocol layer talks to.
 */
export class HttpSession implements Connection {
  /** When this process last served a request for the session. */
  lastRequestAt = Date.now()
  private handshakeDone: boolean
  private waiter: { resolve: (messages: ServerMessage[]) => void; timer: NodeJS.Timeout } | null =
    null
  private grace: NodeJS.Timeout | null = null
  private isOpen = true
  private capturing: ServerMessage[] | null = null

  constructor(
    readonly id: string,
    readonly agentId: string,
    handshakeComplete: boolean,
    private readonly hooks: HttpSessionHooks
  ) {
    this.handshakeDone = handshakeComplete
  }

  get open(): boolean {
    return this.isOpen
  }

  /**
   * Shared through the store, so a poll served by another process knows a
   * later `hello` is not a handshake.
   */
  get handshakeComplete(): boolean {
    return this.handshakeDone
  }

  set handshakeComplete(value: boolean) {
    if (this.handshakeDone === value) return
    this.handshakeDone = value
    if (value) {
      void this.hooks
        .setHandshakeComplete(this.id)
        .catch((error) => this.hooks.onError(error as Error))
    }
  }

  /**
   * Route sends into an array for one request, so synchronous replies (`ready`
   * on open, `pong` on a batch) ride the response instead of the store.
   */
  capture(): { stop(): ServerMessage[] } {
    const captured: ServerMessage[] = []
    this.capturing = captured
    return {
      stop: () => {
        if (this.capturing === captured) this.capturing = null
        return captured
      },
    }
  }

  send(message: ServerMessage): void {
    if (!this.isOpen) return
    if (this.capturing) {
      this.capturing.push(message)
      return
    }
    void this.hooks
      .enqueue(this.id, [message])
      .then(() => this.wake())
      .catch((error) => this.hooks.onError(error as Error))
  }

  wait(ms: number): Promise<ServerMessage[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve([])
      }, ms)
      timer.unref?.()
      this.waiter = { resolve, timer }
    })
  }

  /** Resolve a held poll with whatever the store has queued, plus `extra`. */
  wake(extra: ServerMessage[] = []): void {
    const waiter = this.waiter
    if (!waiter) return
    this.waiter = null
    clearTimeout(waiter.timer)
    void this.hooks
      .drain(this.id)
      .then((queued) => waiter.resolve([...queued, ...extra]))
      .catch((error) => {
        this.hooks.onError(error as Error)
        waiter.resolve(extra)
      })
  }

  close(code: number, reason = '', retryAfterSeconds?: number): void {
    if (!this.isOpen) return
    this.isOpen = false
    // No close frame on this transport, so the advisory is the only way to
    // say why, and the only place a retry hint can travel (PROTOCOL.md §5.6).
    const advisory: CloseMessage | null =
      code >= 4000 || retryAfterSeconds != null ? { type: 'close', code, reason } : null
    if (advisory && retryAfterSeconds != null) advisory.retry_after_seconds = retryAfterSeconds

    if (advisory && this.waiter) {
      // The held poll leaves with the advisory.
      this.wake([advisory])
    } else {
      if (advisory) {
        void this.hooks
          .enqueue(this.id, [advisory])
          .catch((error) => this.hooks.onError(error as Error))
      }
      this.wake()
    }
    // Stay up briefly so one more poll can collect the advisory.
    this.grace = setTimeout(() => this.hooks.destroy(this.id), 5_000)
    this.grace.unref?.()
  }

  markClosed(): void {
    if (this.grace) {
      clearTimeout(this.grace)
      this.grace = null
    }
    this.isOpen = false
    this.wake()
  }
}
