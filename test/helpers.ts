import { Bellhop } from '../src/bellhop.js'
import type { BellhopOptions } from '../src/config.js'
import { fakeLicensing, type FakeLicensing } from '../src/testing/licensing.js'

export { fakeLicensing }
export type { FakeLicensing }

/** A `hello` the way the Mac agent sends one, for tests that drive the HTTP transport by hand. */
export const HELLO = {
  type: 'hello',
  protocol_version: 1,
  agent_version: '1.0.0-test',
  platform: 'macos',
  session_id: 'sess-test',
  capabilities: ['print:zpl'],
  printers: [{ id: 'Fake_ZP450', name: 'Fake ZP450', capabilities: {} }],
  default_printers: { label: 'Fake_ZP450' },
}

export function testBellhop(options: Partial<BellhopOptions> = {}): {
  bellhop: Bellhop
  licensing: FakeLicensing
} {
  const licensing = fakeLicensing()
  const bellhop = new Bellhop({
    secretKey: 'bh_sk_test',
    publicUrl: 'http://localhost:4000',
    apiUrl: 'https://bellhop.test',
    fetch: licensing.fetch,
    ...options,
  })
  return { bellhop, licensing }
}

/**
 * Claim an agent and open an HTTP-transport session on `bellhop` through
 * `handleRequest`, returning the calls a test makes against it.
 */
export async function httpAgent(bellhop: Bellhop, claimToken: string) {
  const claim = await bellhop.handleRequest({
    method: 'POST',
    path: '/claim',
    getHeader: () => undefined,
    body: { claim_token: claimToken },
    ip: '10.0.0.1',
  })
  const token = (claim.body as { agent_token: string }).agent_token
  const auth = (name: string) =>
    name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined

  const opened = await bellhop.handleRequest({
    method: 'POST',
    path: '/sessions',
    getHeader: auth,
    body: HELLO,
  })
  const sessionId = (opened.body as { session_id: string }).session_id

  return {
    token,
    auth,
    sessionId,
    opened,
    poll: (on: Bellhop = bellhop, wait?: number) =>
      on.handleRequest({
        method: 'GET',
        path: `/sessions/${sessionId}/messages`,
        query: wait === undefined ? undefined : new URLSearchParams(`wait=${wait}`),
        getHeader: auth,
      }),
    post: (messages: unknown[], on: Bellhop = bellhop) =>
      on.handleRequest({
        method: 'POST',
        path: `/sessions/${sessionId}/messages`,
        getHeader: auth,
        body: { messages },
      }),
    del: (on: Bellhop = bellhop) =>
      on.handleRequest({ method: 'DELETE', path: `/sessions/${sessionId}`, getHeader: auth }),
  }
}

/** The messages in a transport response body. */
export const messagesOf = (response: { body: unknown }) =>
  (response.body as { messages: Array<Record<string, unknown>> }).messages
