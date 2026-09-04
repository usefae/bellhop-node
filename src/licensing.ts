/**
 * The licensing API: your server talking to bellhop.dev. LICENSING.md is
 * normative.
 *
 * The agent takes no part in this. It only sees the `credential` string these
 * calls return, which your server stores and hands over verbatim. Do not parse
 * it to make decisions; `GET /api/v1/app` is where your code reads
 * entitlements.
 */

import { LicensingError } from './errors.js'

export interface Branding {
  app_name?: string
  accent_color?: string | null
  icon_base64?: string | null
  show_bellhop_branding?: boolean
}

export interface Activation {
  credential: string
  expires_at: string
  serial: string
  branding?: Branding
}

export interface RemoteAgent {
  id: number
  label: string
  status: 'pending' | 'active' | 'deactivated'
}

export interface AppSummary {
  name: string
  publishable_key: string
  plan: string
  entitlements: {
    agent_cap: number
    scales_allowed: boolean
    max_printers: number | null
    remove_branding: boolean
  }
  active_agent_count: number
  in_good_standing: boolean
  /** Whether a webhook URL is registered. Absent from older servers. */
  webhook_registered?: boolean
}

export interface SigningKey {
  kid: string
  alg: string
  public_key: string
}

export interface LicensingClientOptions {
  secretKey: string
  apiUrl: string
  serverHost: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/**
 * The bellhop.dev licensing API, server to server. `Bellhop` owns one as
 * `bellhop.licensing`; construct your own only for tooling.
 */
export class LicensingClient {
  constructor(private readonly options: LicensingClientOptions) {}

  /**
   * Call when someone adds a location in your admin. Store the returned id.
   *
   * `idempotencyKey` travels as an `Idempotency-Key` header. Without one, a
   * request that times out after bellhop.dev accepted it leaves a second agent
   * holding a slot on the plan. The header is sent only when a key is given.
   */
  createAgent(label: string, options: { idempotencyKey?: string } = {}): Promise<RemoteAgent> {
    return this.call(
      'POST',
      '/agents',
      { label },
      options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined
    )
  }

  /**
   * Mint a credential. Called while handling a claim, before the claim token
   * is consumed. `server_host` is the host in the pairing link, not wherever
   * the WebSocket lives.
   */
  activate(remoteId: number): Promise<Activation> {
    return this.call('POST', `/agents/${remoteId}/activate`, {
      server_host: this.options.serverHost,
    })
  }

  /** Same request and response as activate. */
  renew(remoteId: number): Promise<Activation> {
    return this.call('POST', `/agents/${remoteId}/renew`, {
      server_host: this.options.serverHost,
    })
  }

  /** Idempotent. Frees the plan's agent slot. */
  deactivate(remoteId: number): Promise<{ id: number; status: string }> {
    return this.call('POST', `/agents/${remoteId}/deactivate`)
  }

  listAgents(): Promise<{ agents: RemoteAgent[] }> {
    return this.call('GET', '/agents')
  }

  /** Your plan and entitlements. Read them here, never from the credential. */
  app(): Promise<AppSummary> {
    return this.call('GET', '/app')
  }

  /** The credential signing keys. Public and unauthenticated. */
  async signingKeys(): Promise<{ keys: SigningKey[] }> {
    const url = `${this.options.apiUrl}/.well-known/bellhop-keys.json`
    let response: Response
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (cause) {
      throw new LicensingError({ code: 'unreachable', message: describe(cause), status: 0, cause })
    }
    if (!response.ok) {
      throw new LicensingError({ code: 'keys_unavailable', status: response.status })
    }
    try {
      return (await response.json()) as { keys: SigningKey[] }
    } catch (cause) {
      throw new LicensingError({
        code: 'keys_unavailable',
        message: `${url} did not return JSON`,
        status: response.status,
        cause,
      })
    }
  }

  private get fetch(): typeof globalThis.fetch {
    return this.options.fetch ?? globalThis.fetch
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? 15_000
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetch(`${this.options.apiUrl}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      // Unreachable is retryable: the claim token must survive so the operator
      // can try the same link again (PAIRING.md §3).
      throw new LicensingError({ code: 'unreachable', message: describe(cause), status: 0, cause })
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
      message?: string
    }

    if (!response.ok) {
      throw new LicensingError({
        code: payload.error,
        message: payload.message,
        status: response.status,
        body: payload,
      })
    }
    return payload as T
  }
}

/** The most specific sentence a fetch failure offers. Node nests the real reason under `cause`. */
function describe(cause: unknown): string {
  const inner = (cause as { cause?: { code?: string; message?: string } } | undefined)?.cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return inner?.code ? `${message} (${inner.code})` : message
}
