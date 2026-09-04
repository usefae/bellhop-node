/** Token handling, PAIRING.md §7, in one place. */

import crypto from 'node:crypto'

/** Unguessable. Used for claim tokens and agent tokens. */
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url')

/** Tokens are stored as SHA-256 digests, never as themselves. */
export const digest = (value: string): string =>
  crypto.createHash('sha256').update(String(value)).digest('hex')

/**
 * Constant-time comparison. `timingSafeEqual` throws on differing lengths, so
 * they are checked first. That leaks length, which does not matter here: every
 * value compared is a fixed-width SHA-256 digest.
 */
export function secureEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/** `Authorization: Bearer <token>`, or null. The agent never uses a query string. */
export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

const SECRET_KEYS = /token|credential|secret|authorization|claim/i

/**
 * Redact anything token-shaped before it reaches a log line. Every log this
 * library emits goes through it, which is why a pairing link never appears in
 * output: the link is the claim token. An Error keeps its name, message, and
 * stack, which are not enumerable and would otherwise vanish.
 */
export function redact<T>(value: T): T {
  if (value instanceof Error) {
    const own = redact({ ...value } as Record<string, unknown>)
    return { ...own, name: value.name, message: value.message, stack: value.stack } as unknown as T
  }
  if (value instanceof Date) return value.toISOString() as unknown as T
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(redact) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : redact(entry)
  }
  return out as T
}

/**
 * A fixed-window limiter for the claim endpoint, which has to be
 * unauthenticated: the agent has no credential yet. In memory, so it caps one
 * process. Behind more than one, put a shared limiter in front. The map is
 * bounded at `maxKeys`; past that the oldest window is evicted.
 */
export function rateLimiter({ max = 10, windowMs = 60_000, maxKeys = 10_000 } = {}) {
  const hits = new Map<string, { start: number; count: number }>()

  return {
    /** True when the caller is over its allowance. */
    exceeded(key: string): boolean {
      const now = Date.now()
      const entry = hits.get(key)
      if (entry && entry.start >= now - windowMs) return ++entry.count > max
      // A fresh window. Delete before set so the key moves to the end of the
      // insertion order, which is what makes evicting the first key evict the
      // oldest window.
      hits.delete(key)
      hits.set(key, { start: now, count: 1 })
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value!)
      return false
    },
  }
}
