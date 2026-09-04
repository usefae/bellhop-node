/**
 * The types in `src/types.ts` are written by hand so they can carry
 * documentation. This is what stops them drifting from the protocol schemas:
 * every message this library sends is validated against them. The schemas
 * are vendored under `test/fixtures` so the package tests stand alone; when
 * the Bellhop repository's `docs/schemas/v1` is present, the last test keeps
 * the two copies identical.
 *
 * Messages the library receives are deliberately not validated. Both sides
 * ignore what they do not recognise (PROTOCOL.md, design rule 4), and
 * rejecting an agent's message for failing a schema would break that.
 */

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeAgent } from '../src/testing/index.js'
import { testBellhop } from './helpers.js'
import type { Bellhop } from '../src/bellhop.js'
import type { ServerMessage } from '../src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaDir = path.resolve(here, 'fixtures/schemas/v1')
const normativeDir = path.resolve(here, '../../../docs/schemas/v1')
const SCHEMAS = ['agent-to-server.json', 'server-to-agent.json']

const load = (name: string): object =>
  JSON.parse(readFileSync(path.join(schemaDir, name), 'utf8')) as object

const ajv = new Ajv2020.default({ strict: false, allErrors: true })
addFormats.default(ajv)

const validateServerMessage = ajv.compile(load('server-to-agent.json'))
const validateAgentMessage = ajv.compile(load('agent-to-server.json'))

const assertValid = (validate: typeof validateServerMessage, message: unknown): void => {
  if (!validate(message)) {
    throw new Error(
      `${JSON.stringify(message)}\n\n${ajv.errorsText(validate.errors, { separator: '\n' })}`
    )
  }
}

let open: Bellhop[] = []
afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

describe('messages this library sends', () => {
  it('ready, print, pong, and close', async () => {
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { claimToken } = await bellhop.agents.create({ label: 'Desk' })
    const agent = await fakeAgent(bellhop, { claimToken })

    await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    await agent.waitForPrint()
    await bellhop.print(agent.agentId, {
      kind: 'packing_slip',
      format: 'pdf',
      url: 'https://example.com/slip.pdf?sig=abc',
    })
    // Every option pdf takes, so the schema's closed set is checked against
    // the one this library sends.
    await bellhop.print(agent.agentId, {
      kind: 'packing_slip',
      format: 'pdf',
      printer: 'Fake_LaserJet',
      options: {
        copies: 2,
        duplex: 'long-edge',
        paper: 'Letter',
        bin: 'Tray1',
        dpi: 600,
        color: true,
        pages: '1-4,7,9-12',
        rotate: 90,
        fit: false,
        collate: true,
        nup: 2,
      },
      url: 'https://example.com/slip.pdf?sig=abc',
    })
    await bellhop.print(agent.agentId, {
      kind: 'receipt',
      format: 'raw',
      printer: 'Fake_ZP450',
      options: { copies: 3 },
      data: Buffer.from([0x1b, 0x40]),
    })
    await agent.ping()

    const kinds = new Set(agent.messages.map((message) => message.type))
    expect(kinds).toContain('ready')
    expect(kinds).toContain('print')
    expect(kinds).toContain('pong')

    for (const message of agent.messages) assertValid(validateServerMessage, message)
  })

  it('the close advisory', () => {
    const message: ServerMessage = {
      type: 'close',
      code: 4001,
      reason: 'This agent was re-paired elsewhere.',
    }
    assertValid(validateServerMessage, message)
  })

  it('the credential push a renewal sends', () => {
    assertValid(validateServerMessage, { type: 'credential', credential: 'a.b.c' })
  })

  it('config', () => {
    assertValid(validateServerMessage, {
      type: 'config',
      app_name: 'Deliver',
      accent_color: '#4F46E5',
    })
  })
})

describe('agent messages the tests use', () => {
  it('hello, ack, weight, event, ping, pong', () => {
    const messages = [
      {
        type: 'hello',
        protocol_version: 1,
        agent_version: '1.2.0',
        platform: 'macos',
        session_id: '5b1f9c2e-7d3a-4f18-9a44-6b0e2d1c8f77',
        capabilities: ['print:zpl', 'print:raw', 'print:pdf', 'scale'],
        printers: [
          {
            id: 'Zebra_ZP450',
            name: 'Zebra ZP450',
            capabilities: {
              papers: ['w288h432'],
              default_paper: 'w288h432',
              dpi: [203],
              default_dpi: 203,
              duplex: false,
              color: false,
            },
          },
          // A queue whose driver could not be read at all.
          { id: 'Shared_From_Reception', name: 'Reception printer', capabilities: {} },
        ],
        default_printers: { label: 'Zebra_ZP450' },
      },
      { type: 'ack', id: 'job_7f2a1c', status: 'printed', error: null },
      {
        type: 'ack',
        id: 'job_9c31b8',
        status: 'failed',
        error_code: 'unsupported_value',
        error: 'Office HP LaserJet has no paper size "w288h360".',
      },
      { type: 'weight', grams: 1240, stable: true },
      { type: 'event', code: 'scale_detached', message: 'The scale was unplugged.' },
      { type: 'ping', token: 'abc123' },
      { type: 'pong', token: 'abc123' },
    ]
    for (const message of messages) assertValid(validateAgentMessage, message)
  })
})

describe.skipIf(!existsSync(normativeDir))('the vendored schemas', () => {
  it('match the normative copies in docs/schemas/v1', () => {
    for (const name of SCHEMAS) {
      expect(readFileSync(path.join(schemaDir, name), 'utf8')).toBe(
        readFileSync(path.join(normativeDir, name), 'utf8')
      )
    }
  })
})
