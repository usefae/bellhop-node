import { ConfigurationError } from './errors.js'
import type { Presence, PubSub } from './connections.js'
import type { Store } from './store/types.js'

/**
 * Constructor options for {@link Bellhop}. `secretKey` and `publicUrl` are
 * required; everything else has a default.
 */
export interface BellhopOptions {
  /** Your app's secret key from bellhop.dev. Shown exactly once; keep it out of source. */
  secretKey: string

  /**
   * This application's public base URL, with the port if it is not the
   * scheme's default. Its host is the pairing host: it goes in every pairing
   * link and every credential is bound to it. Pick it once; changing it after
   * agents have paired means all of them re-pair. The WebSocket may live on
   * another host, which is what `transports` in the claim response is for.
   */
  publicUrl: string

  /** Defaults to `memoryStore()`, which does not survive a restart. */
  store?: Store

  /** The licensing API. Defaults to `https://bellhop.dev`. */
  apiUrl?: string

  /**
   * Display name and colour handed to the agent. Both default to what
   * bellhop.dev has registered for the app; these only fill the gap before an
   * agent activates.
   */
  appName?: string
  accentColor?: string

  /** Where the routes are mounted. Default `/bellhop`. */
  basePath?: string

  /** Requested agent keepalive, in seconds. The agent clamps it to 5 to 120. */
  heartbeatSeconds?: number

  /**
   * How long the HTTP transport holds a poll open. Set it to `0` on a platform
   * that will not let you hold a request; the agent then polls every 3 seconds
   * (TRANSPORTS.md §4).
   */
  pollSeconds?: number

  /** How long a pairing link stays usable. Default one hour. */
  claimTtlMs?: number

  /** Renew credentials this far ahead of expiry. */
  renewWithinDays?: number

  /**
   * Renew expiring credentials automatically once a transport is attached.
   * Default true. Turn it off only if your own job runner calls `renew()`.
   */
  autoRenew?: boolean

  /** Cross-process fanout. The default is in-process. */
  pubsub?: PubSub

  /**
   * How online/offline is answered. The default combines this process's
   * connections with the store's `lastSeenAt` within three heartbeats, which
   * is correct across processes whenever the store is shared.
   */
  presence?: Presence

  /** Attempts per IP per minute against the claim endpoint. Default 10. */
  claimRateLimit?: { max: number; windowMs: number } | false

  /**
   * Anything with `info`, `warn`, and `error`. Silent by default. Internal
   * failures reach `error` when nothing listens for the `error` event.
   */
  logger?: Logger

  /** Injected in tests. */
  fetch?: typeof globalThis.fetch
  now?: () => number
}

export interface Logger {
  info?(message: string, context?: unknown): void
  warn?(message: string, context?: unknown): void
  error?(message: string, context?: unknown): void
}

export interface ResolvedConfig {
  secretKey: string
  publicUrl: string
  /** `host[:port]`, exactly as the agent derives it. */
  serverHost: string
  apiUrl: string
  appName: string | undefined
  accentColor: string | undefined
  basePath: string
  heartbeatSeconds: number
  pollSeconds: number
  claimTtlMs: number
  renewWithinDays: number
  autoRenew: boolean
  claimRateLimit: { max: number; windowMs: number } | false
  socketUrl: string
  httpUrl: string
}

export function resolveConfig(options: BellhopOptions): ResolvedConfig {
  if (!options.secretKey) {
    throw new ConfigurationError(
      'secretKey is required. Find it on your app’s page on bellhop.dev.',
      'missing_secret_key'
    )
  }
  if (!options.publicUrl) {
    throw new ConfigurationError(
      'publicUrl is required. It is this application’s public base URL, and its host becomes the pairing host.',
      'missing_public_url'
    )
  }

  let parsed: URL
  try {
    parsed = new URL(options.publicUrl)
  } catch (cause) {
    throw new ConfigurationError(
      `publicUrl is not a URL: ${options.publicUrl}. Include the scheme, e.g. https://deliver.example.com`,
      'invalid_public_url',
      cause
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigurationError(
      `publicUrl must be http or https, got ${parsed.protocol}`,
      'invalid_public_url'
    )
  }
  if (parsed.protocol === 'http:' && !isLoopback(parsed.hostname)) {
    throw new ConfigurationError(
      `publicUrl must be https except on localhost. The agent refuses plain http to ${parsed.hostname}.`,
      'invalid_public_url'
    )
  }

  const publicUrl = `${parsed.origin}`
  const basePath = normalizeBasePath(options.basePath ?? '/bellhop')
  const socketScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:'

  return {
    secretKey: options.secretKey,
    publicUrl,
    // `URL.host` keeps a non-default port and drops a default one, which is
    // how the agent derives its own pairing key.
    serverHost: parsed.host,
    apiUrl: (options.apiUrl ?? 'https://bellhop.dev').replace(/\/+$/, ''),
    appName: options.appName,
    accentColor: options.accentColor,
    basePath,
    heartbeatSeconds: options.heartbeatSeconds ?? 20,
    pollSeconds: options.pollSeconds ?? 25,
    claimTtlMs: options.claimTtlMs ?? 60 * 60 * 1000,
    renewWithinDays: options.renewWithinDays ?? 30,
    autoRenew: options.autoRenew ?? true,
    claimRateLimit:
      options.claimRateLimit === false
        ? false
        : (options.claimRateLimit ?? { max: 10, windowMs: 60_000 }),
    socketUrl: `${socketScheme}//${parsed.host}${basePath}/socket`,
    httpUrl: `${publicUrl}${basePath}`,
  }
}

function normalizeBasePath(value: string): string {
  const trimmed = `/${value.replace(/^\/+|\/+$/g, '')}`
  return trimmed === '/' ? '' : trimmed
}

export const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
