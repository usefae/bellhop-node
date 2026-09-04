/**
 * Printer inventory, per-job targeting, and print options: what the library
 * refuses at the call site, and what it carries through to the agent.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fakeAgent } from '../src/testing/index.js'
import { AgentError } from '../src/errors.js'
import { testBellhop } from './helpers.js'
import type { Bellhop } from '../src/bellhop.js'
import type { AgentMessage, Printer, PrintOptions } from '../src/types.js'

let open: Bellhop[] = []

afterEach(async () => {
  for (const bellhop of open) await bellhop.close()
  open = []
})

async function paired(options: Partial<Parameters<typeof fakeAgent>[1]> = {}) {
  const { bellhop } = testBellhop()
  open.push(bellhop)
  const { claimToken } = await bellhop.agents.create({ label: 'Shipping Desk' })
  const agent = await fakeAgent(bellhop, { claimToken, ...options })
  return { bellhop, agent }
}

/** Sidestep the type for options that should be refused at runtime. */
const refuse = (options: unknown): PrintOptions => options as PrintOptions

describe('the inventory a hello carries', () => {
  it('stores every shared printer and what it can do', async () => {
    const { bellhop, agent } = await paired()

    const record = (await bellhop.agents.get(agent.agentId))!
    expect(record.printers.map((printer) => printer.id)).toEqual(['Fake_ZP450', 'Fake_LaserJet'])
    const laser = record.printers.find((printer) => printer.id === 'Fake_LaserJet')!
    expect(laser.name).toBe('Fake LaserJet')
    expect(laser.capabilities).toMatchObject({
      papers: ['Letter', 'Legal', 'A4'],
      default_paper: 'Letter',
      duplex: true,
      color: true,
    })
    expect(record.defaultPrinters).toEqual({ label: 'Fake_ZP450', document: 'Fake_LaserJet' })
  })

  it('replaces the inventory wholesale rather than merging it', async () => {
    const { bellhop, agent } = await paired()
    const kept: Printer[] = [
      { id: 'Only_One_Now', name: 'Only one now', capabilities: { papers: ['Letter'] } },
    ]

    // What the operator unsharing a printer looks like from here.
    await agent.sendHello({ printers: kept, defaultPrinters: { label: 'Only_One_Now' } })

    const record = (await bellhop.agents.get(agent.agentId))!
    expect(record.printers.map((printer) => printer.id)).toEqual(['Only_One_Now'])
    expect(record.defaultPrinters).toEqual({ label: 'Only_One_Now' })
  })

  it('reports the inventory on the hello event', async () => {
    const { bellhop, agent } = await paired()
    const seen: { printers: Printer[]; defaultPrinters: Record<string, string> }[] = []
    bellhop.on('hello', ({ printers, defaultPrinters }) => seen.push({ printers, defaultPrinters }))

    await agent.sendHello()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.printers.map((printer) => printer.name)).toEqual([
      'Fake ZP450',
      'Fake LaserJet',
    ])
    expect(seen[0]!.defaultPrinters.label).toBe('Fake_ZP450')
  })

  it('reads a malformed inventory defensively, keeping capabilities it does not know', async () => {
    const { bellhop, agent } = await paired()

    await agent.emit({
      type: 'hello',
      protocol_version: 1,
      agent_version: '1.0.0-fake',
      platform: 'macos',
      session_id: 'junk',
      capabilities: ['print:zpl'],
      printers: [
        // A capability from some future version. Rule 4: carry it, ignore it.
        { id: 'Good', name: 'Good', capabilities: { papers: ['Letter'], tearoff: 'auto' } },
        // Nothing here can be targeted or displayed, so it is not a printer.
        { name: 'No id at all', capabilities: {} },
        'nonsense',
      ],
      default_printers: { label: 'Good', document: 42 },
    } as unknown as AgentMessage)

    const record = (await bellhop.agents.get(agent.agentId))!
    expect(record.printers).toHaveLength(1)
    expect(record.printers[0]!.capabilities).toEqual({ papers: ['Letter'], tearoff: 'auto' })
    expect(record.defaultPrinters).toEqual({ label: 'Good' })
  })
})

describe('targeting a printer', () => {
  it('refuses one the agent has not shared', async () => {
    const { bellhop, agent } = await paired()

    await expect(
      bellhop.print(agent.agentId, {
        kind: 'label',
        format: 'zpl',
        printer: 'Payroll_Down_The_Hall',
        data: '^XA^XZ',
      })
    ).rejects.toThrow(/has not shared a printer called "Payroll_Down_The_Hall"/)
  })

  it('carries a shared one through to the agent', async () => {
    const { bellhop, agent } = await paired()

    const job = await bellhop.print(agent.agentId, {
      kind: 'packing_slip',
      format: 'pdf',
      printer: 'Fake_LaserJet',
      url: 'https://example.com/slip.pdf',
    })
    await agent.waitForPrint()

    expect(agent.printed[0]!.printer).toBe('Fake_LaserJet')
    expect((await bellhop.jobs.get(job.id))!.printer).toBe('Fake_LaserJet')
  })

  it('leaves the printer out entirely when the job routes by format', async () => {
    const { bellhop, agent } = await paired()

    await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })
    await agent.waitForPrint()

    const print = agent.received[0]!
    expect('printer' in print).toBe(false)
    expect(agent.printed[0]!.printer).toBeNull()
  })

  it('accepts any printer for an agent that has never connected', async () => {
    // Queueing for an agent nobody has paired yet is legitimate, and an empty
    // inventory means it has never said anything about itself.
    const { bellhop } = testBellhop()
    open.push(bellhop)
    const { agent } = await bellhop.agents.create({ label: 'Not paired yet' })

    const job = await bellhop.print(agent.id, {
      kind: 'label',
      format: 'zpl',
      printer: 'Whatever_It_Turns_Out_To_Have',
      data: '^XA^XZ',
    })
    expect(job.status).toBe('pending')
    expect(job.printer).toBe('Whatever_It_Turns_Out_To_Have')
  })

  it('reports the target on the print event', async () => {
    const { bellhop, agent } = await paired()
    const seen: (string | null)[] = []
    bellhop.on('print', ({ printer }) => seen.push(printer))

    await bellhop.print(agent.agentId, {
      kind: 'label',
      format: 'zpl',
      printer: 'Fake_ZP450',
      data: '^XA^XZ',
    })
    await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: '^XA^XZ' })

    expect(seen).toEqual(['Fake_ZP450', null])
  })
})

describe('print options', () => {
  it('refuses an option name that does not exist', async () => {
    const { bellhop, agent } = await paired()

    await expect(
      bellhop.print(agent.agentId, {
        kind: 'slip',
        format: 'pdf',
        options: refuse({ copies: 2, duplx: 'long-edge' }),
        url: 'https://example.com/slip.pdf',
      })
    ).rejects.toThrow(/`options.duplx` is not a print option/)

    // Nothing was queued: a refused job never becomes a job.
    expect(await bellhop.jobs.recent()).toEqual([])
  })

  it('refuses an option that means nothing for this format', async () => {
    const { bellhop, agent } = await paired()

    await expect(
      bellhop.print(agent.agentId, {
        kind: 'label',
        format: 'gif',
        options: { duplex: 'long-edge' },
        url: 'https://example.com/label.gif',
      })
    ).rejects.toThrow(/`options.duplex` does not apply to a gif job. It applies to: pdf./)

    // ZPL takes copies and nothing else. Everything else is decided by the
    // byte stream.
    await expect(
      bellhop.print(agent.agentId, {
        kind: 'label',
        format: 'zpl',
        options: { paper: 'w288h432' },
        data: '^XA^XZ',
      })
    ).rejects.toThrow(/does not apply to a zpl job/)
  })

  it('refuses a value outside its range or enum', async () => {
    const { bellhop, agent } = await paired()
    const bad = async (options: unknown, expected: RegExp) => {
      await expect(
        bellhop.print(agent.agentId, {
          kind: 'slip',
          format: 'pdf',
          options: refuse(options),
          url: 'https://example.com/slip.pdf',
        })
      ).rejects.toThrow(expected)
    }

    await bad({ copies: 0 }, /`options.copies` must be a whole number from 1 to 100/)
    await bad({ copies: 101 }, /copies/)
    await bad({ copies: 2.5 }, /copies/)
    await bad({ copies: '2' }, /copies/)
    await bad({ duplex: 'sideways' }, /"one-sided", "long-edge", or "short-edge"/)
    await bad({ rotate: 45 }, /0, 90, 180, or 270/)
    await bad({ nup: 3 }, /1, 2, 4, 6, 9, or 16/)
    await bad({ dpi: 0 }, /resolution/)
    await bad({ collate: 'yes' }, /true or false/)
    await bad({ paper: '' }, /paper keyword/)
  })

  it('refuses a page range that does not parse', async () => {
    const { bellhop, agent } = await paired()
    const pages = async (value: string) =>
      bellhop.print(agent.agentId, {
        kind: 'slip',
        format: 'pdf',
        options: { pages: value },
        url: 'https://example.com/slip.pdf',
      })

    // Ascending, non-overlapping, one-based, no spaces.
    for (const value of ['7,1-4', '4-1', '1-4, 7', '0-3', '1-4,4-6', '', '1--4', 'all']) {
      await expect(pages(value)).rejects.toThrow(/`options.pages` must be/)
    }
    for (const value of ['3', '1-4,7,9-12', '1-1']) {
      await expect(pages(value)).resolves.toBeDefined()
    }
  })

  it('refuses raw when the agent does not advertise print:raw', async () => {
    const { bellhop, agent } = await paired({ capabilities: ['print:zpl', 'print:pdf'] })

    await expect(
      bellhop.print(agent.agentId, { kind: 'receipt', format: 'raw', data: 'hello' })
    ).rejects.toThrow(AgentError)
    await expect(
      bellhop.print(agent.agentId, { kind: 'receipt', format: 'raw', data: 'hello' })
    ).rejects.toThrow(/does not advertise print:raw/)
  })

  it('refuses the target before the format, as the agent resolves them', async () => {
    // A job with more than one thing wrong reports the same thing here that it
    // would from the desk (PROTOCOL.md §5.2.3).
    const { bellhop, agent } = await paired({ capabilities: ['print:zpl'] })

    await expect(
      bellhop.print(agent.agentId, {
        kind: 'slip',
        format: 'pdf',
        printer: 'Not_Shared',
        options: refuse({ duplx: true }),
        url: 'https://example.com/slip.pdf',
      })
    ).rejects.toThrow(/has not shared a printer/)
  })

  it('accepts a job carrying options and a printer, and delivers both verbatim', async () => {
    const { bellhop, agent } = await paired()
    const options: PrintOptions = {
      copies: 2,
      duplex: 'long-edge',
      paper: 'Letter',
      bin: 'Tray1',
      pages: '1-4,7',
      collate: true,
    }

    const job = await bellhop.print(agent.agentId, {
      kind: 'packing_slip',
      format: 'pdf',
      printer: 'Fake_LaserJet',
      options,
      url: 'https://example.com/slip.pdf',
    })
    await agent.waitForPrint()

    // Stored, delivered, and read back identically.
    expect((await bellhop.jobs.get(job.id))!.options).toEqual(options)
    expect(agent.printed[0]!.options).toEqual(options)
    expect(agent.received[0]).toMatchObject({ printer: 'Fake_LaserJet', options })
  })

  it('carries copies on a raw job, which is the one option raw takes', async () => {
    const { bellhop, agent } = await paired()

    await bellhop.print(agent.agentId, {
      kind: 'receipt',
      format: 'raw',
      printer: 'Fake_ZP450',
      options: { copies: 3 },
      data: Buffer.from([0x1b, 0x40, 0x0a]),
    })
    await agent.waitForPrint()

    expect(agent.printed[0]!.options).toEqual({ copies: 3 })
    expect(agent.printed[0]!.data).toEqual(Buffer.from([0x1b, 0x40, 0x0a]))
  })

  it('sends no options at all when there is nothing to say', async () => {
    const { bellhop, agent } = await paired()

    // An object left empty by a caller spreading a partial one together.
    const job = await bellhop.print(agent.agentId, {
      kind: 'label',
      format: 'zpl',
      options: { copies: undefined },
      data: '^XA^XZ',
    })
    await agent.waitForPrint()

    expect((await bellhop.jobs.get(job.id))!.options).toBeNull()
    expect('options' in agent.received[0]!).toBe(false)
  })
})

describe('the memory store', () => {
  it('carries a printer, options, and an inventory through a round trip', async () => {
    // `sqliteStore` cannot run under vitest (Vite cannot resolve
    // `node:sqlite`), so the round trip is checked on the memory store.
    const { bellhop, agent } = await paired()

    const job = await bellhop.print(agent.agentId, {
      kind: 'packing_slip',
      format: 'pdf',
      printer: 'Fake_LaserJet',
      options: { copies: 2, duplex: 'short-edge', dpi: 600 },
      url: 'https://example.com/slip.pdf',
    })
    await agent.waitForPrint()

    const stored = (await bellhop.jobs.get(job.id))!
    expect(stored.printer).toBe('Fake_LaserJet')
    expect(stored.options).toEqual({ copies: 2, duplex: 'short-edge', dpi: 600 })
    // Acking must not disturb either of them.
    expect(stored.status).toBe('printed')

    // A job that names nothing stores nothing, rather than an empty object.
    const plain = await bellhop.print(agent.agentId, {
      kind: 'label',
      format: 'zpl',
      data: '^XA^XZ',
    })
    const plainStored = (await bellhop.jobs.get(plain.id))!
    expect(plainStored.printer).toBeNull()
    expect(plainStored.options).toBeNull()
  })
})
