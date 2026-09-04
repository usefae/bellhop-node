import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'

export interface FakeLicensingState {
  nextAgentId: number
  activations: number
  renewals: number
  deactivations: number
  /** The headers of each `POST /agents`, in order. */
  createHeaders: Record<string, string>[]
  /**
   * What `GET /api/v1/agents` answers with. Flip a status to 'deactivated' to
   * stand for a removal on bellhop.dev.
   */
  remoteAgents: { id: number; label: string; status: string }[]
  /** When set, activation answers this error instead of a credential. */
  failActivation: { code: string; status: number } | null
  /** When true, the well-known key endpoint answers 503. */
  failKeys: boolean
  scalesAllowed: boolean
  /** How far out each minted credential expires. Far enough that nothing renews mid-test. */
  credentialTtlMs: number
}

export interface FakeLicensing {
  /** Pass as `fetch` to `new Bellhop({ ... })`. */
  fetch: typeof globalThis.fetch
  /** Counters and switches. Mutate between calls. */
  state: FakeLicensingState
  /** A `Bellhop-Signature` header bellhop.dev would send, signed with this fake's key. */
  signWebhook(options?: { t?: number; event?: string; app?: string; kid?: string }): string
}

/**
 * A stand-in for bellhop.dev. Every test that pairs an agent needs one,
 * because activation happens before a claim token is consumed and there is
 * no way to skip it.
 *
 *   const licensing = fakeLicensing()
 *   const bellhop = new Bellhop({ secretKey: 'test', publicUrl: 'http://localhost:3000', fetch: licensing.fetch })
 *
 * It answers every licensing route, publishes a real Ed25519 key so webhook
 * signatures verify for real, and reports the app as `Test App` on a plan
 * with 100 agent slots and scales allowed.
 */
export function fakeLicensing(overrides: Partial<FakeLicensingState> = {}): FakeLicensing {
  const state: FakeLicensingState = {
    nextAgentId: 1,
    activations: 0,
    renewals: 0,
    deactivations: 0,
    createHeaders: [],
    remoteAgents: [],
    failActivation: null,
    failKeys: false,
    scalesAllowed: true,
    credentialTtlMs: 90 * 24 * 60 * 60 * 1000,
    ...overrides,
  }

  // The "junk" entry in the published set is deliberate: one malformed key
  // must not take down the one that verifies.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawPublicKey = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)

  const signWebhook: FakeLicensing['signWebhook'] = (options = {}) => {
    const t = options.t ?? Math.floor(Date.now() / 1000)
    const event = options.event ?? 'app.entitlements_changed'
    const app = options.app ?? 'bh_pk_test'
    const kid = options.kid ?? '2026-08'
    const signature = signWithKey(null, Buffer.from(`${t}.${event}.${app}`), privateKey)
    return `t=${t},kid=${kid},v1=${signature.toString('base64')}`
  }

  const activation = () => ({
    credential: 'header.payload.signature',
    expires_at: new Date(Date.now() + state.credentialTtlMs).toISOString(),
    serial: 'serial-1',
    branding: { app_name: 'Test App', accent_color: '#4F46E5' },
  })

  /** Lowercased, so a test asserts on a header name rather than its casing. */
  const headersOf = (init: RequestInit | undefined): Record<string, string> => {
    const collected: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      collected[name.toLowerCase()] = value
    })
    return collected
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/v1/agents') && method === 'POST') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        label: string
      }
      state.createHeaders.push(headersOf(init))
      const created = { id: state.nextAgentId++, label: body.label, status: 'pending' }
      state.remoteAgents.push(created)
      return json(created, 201)
    }

    if (/\/agents\/\d+\/activate$/.test(url)) {
      state.activations++
      if (state.failActivation) {
        return json(
          { error: state.failActivation.code, message: 'nope' },
          state.failActivation.status
        )
      }
      return json(activation())
    }

    if (/\/agents\/\d+\/renew$/.test(url)) {
      state.renewals++
      return json(activation())
    }

    if (/\/agents\/\d+\/deactivate$/.test(url)) {
      state.deactivations++
      return json({ id: 1, status: 'deactivated' })
    }

    if (url.endsWith('/api/v1/agents')) return json({ agents: state.remoteAgents })

    if (url.endsWith('/api/v1/app')) {
      return json({
        name: 'Test App',
        publishable_key: 'bh_pk_test',
        plan: 'platform',
        entitlements: {
          agent_cap: 100,
          scales_allowed: state.scalesAllowed,
          max_printers: null,
          remove_branding: true,
        },
        active_agent_count: 1,
        in_good_standing: true,
        webhook_registered: true,
      })
    }

    if (url.endsWith('/.well-known/bellhop-keys.json')) {
      if (state.failKeys) return json({ error: 'unavailable' }, 503)
      return json({
        keys: [
          { kid: 'junk', alg: 'EdDSA', public_key: 'AAAA' },
          { kid: '2026-08', alg: 'EdDSA', public_key: rawPublicKey.toString('base64') },
        ],
      })
    }

    return json({ error: 'not_found' }, 404)
  }

  return { fetch, state, signWebhook }
}
