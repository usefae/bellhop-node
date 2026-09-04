/**
 * Verifies the Bellhop-Signature header on an inbound webhook (LICENSING.md,
 * "Webhooks").
 *
 * bellhop.dev signs `t.event.app` with the same Ed25519 keys that sign
 * credentials, so the public keys come from the well-known endpoint and there
 * is no webhook secret. The body is not signed: everything a receiver acts on
 * is in the signed string, and the only thing a delivery can cause is a
 * re-mint through the authenticated API.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import type { LicensingClient } from './licensing.js'

/**
 * How far a delivery's `t` may sit from this machine's clock, in seconds.
 * bellhop.dev retries well beyond this, so a delivery rejected for drift comes
 * back once somebody fixes the clock.
 */
const TOLERANCE = 5 * 60

/** Minimum time between key refetches when a kid is unknown. */
const REFETCH_INTERVAL_MS = 60_000

/** How long a fetched key set is trusted before it is fetched again. */
const MAX_AGE_MS = 10 * 60_000

/** DER header that turns a raw 32-byte Ed25519 key into what `createPublicKey` wants. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface SignatureFields {
  t: number
  kid: string
  v1: string
}

/**
 * `t=1755245000,kid=2026-08,v1=<base64>` as fields, or null. Unknown fields
 * pass through, so a future signature version stays parseable.
 */
export function parseSignatureHeader(header: string | undefined): SignatureFields | null {
  if (!header) return null
  const fields = new Map(
    header.split(',').map((field) => {
      const at = field.indexOf('=')
      return at === -1 ? [field, ''] : [field.slice(0, at), field.slice(at + 1)]
    })
  )
  const t = fields.get('t')
  const kid = fields.get('kid')
  const v1 = fields.get('v1')
  if (!t || !/^\d+$/.test(t) || !kid || !v1) return null
  return { t: Number(t), kid, v1 }
}

/**
 * Checks a Bellhop-Signature header against the keys bellhop.dev publishes.
 * `Bellhop` owns one; construct your own only to verify deliveries you route
 * yourself.
 */
export class WebhookVerifier {
  private keys: Map<string, KeyObject> | null = null
  private fetchedAt = 0
  private inflight: Promise<void> | null = null

  constructor(
    private readonly licensing: LicensingClient,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Whether `header` is bellhop.dev vouching for `event` and `app` right now.
   * Throws a LicensingError only when the key set is needed and cannot be
   * fetched. Answer that with a 5xx so the delivery is retried.
   */
  async valid(header: string | undefined, claim: { event: string; app: string }): Promise<boolean> {
    const fields = parseSignatureHeader(header)
    if (!fields) return false
    if (Math.abs(this.now() / 1000 - fields.t) > TOLERANCE) return false

    const key = await this.publicKey(fields.kid)
    if (!key) return false

    // A corrupt v1 fails to verify; `Buffer.from` does not throw.
    const signed = Buffer.from(`${fields.t}.${claim.event}.${claim.app}`)
    return verifySignature(null, signed, key, Buffer.from(fields.v1, 'base64'))
  }

  /** Forget the cached keys. */
  reset(): void {
    this.keys = null
    this.fetchedAt = 0
  }

  private async publicKey(kid: string): Promise<KeyObject | null> {
    // A stale set is refreshed even for a known kid, so a key withdrawn from
    // the published set stops verifying within MAX_AGE_MS.
    if (!this.keys || this.now() - this.fetchedAt >= MAX_AGE_MS) await this.fetch()
    // An unknown kid usually means rotation, so ask again, rate limited.
    if (!this.keys?.has(kid) && this.now() - this.fetchedAt >= REFETCH_INTERVAL_MS) {
      await this.fetch()
    }
    return this.keys?.get(kid) ?? null
  }

  /** One fetch at a time. Concurrent deliveries after a cold start share it. */
  private fetch(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * A key that does not parse is skipped, so one malformed entry cannot take
   * down the ones that verify.
   */
  private async load(): Promise<void> {
    const { keys } = await this.licensing.signingKeys()
    const parsed = new Map<string, KeyObject>()
    for (const entry of keys) {
      try {
        const raw = Buffer.from(entry.public_key, 'base64')
        if (raw.length !== 32) continue
        parsed.set(
          entry.kid,
          createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
        )
      } catch {
        // Not an Ed25519 public key.
      }
    }
    this.keys = parsed
    this.fetchedAt = this.now()
  }
}
