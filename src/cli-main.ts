/**
 * The `bellhop` command. `cli.ts` is the executable stub; everything testable
 * lives here and takes its inputs as arguments.
 */

import { createRequire } from 'node:module'
import { parseArgs } from 'node:util'
import { Bellhop } from './bellhop.js'
import { LicensingError } from './errors.js'
import { sqliteStore } from './store/sqlite.js'

const HELP = `
Usage: bellhop <command>

  doctor              check the environment end to end
  pair <label>        create an agent and print its pairing link
  agents              list agents known to bellhop.dev

Options
  --api-url <url>     default $BELLHOP_API_URL or https://bellhop.dev
  --public-url <url>  default $BELLHOP_PUBLIC_URL
  --secret-key <key>  default $BELLHOP_SECRET_KEY
  --db <path>         default $BELLHOP_DB: the SQLite file your server uses.
                      pair needs it, and doctor reports its agents when given.
  -h, --help
  -v, --version

Run it as \`npx @usefae/bellhop-node doctor\`, or \`npx bellhop doctor\` inside a project
that has @usefae/bellhop-node installed.

If the licensing host's certificate comes from the OS trust store, Node needs
--use-system-ca to accept it:

  node --use-system-ca node_modules/.bin/bellhop doctor
`

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface CliDeps {
  /** Stands in for bellhop.dev in tests. */
  fetch?: typeof globalThis.fetch
  /** Whether to colour output. Defaults to a terminal check. */
  colour?: boolean
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  deps: CliDeps = {}
): Promise<number> {
  const paint = deps.colour ?? wantsColour(env)
  const c = {
    green: paint ? '\x1b[32m' : '',
    red: paint ? '\x1b[31m' : '',
    dim: paint ? '\x1b[2m' : '',
    bold: paint ? '\x1b[1m' : '',
    reset: paint ? '\x1b[0m' : '',
  }

  let values: Record<string, string | boolean | undefined>
  let positionals: string[]
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'api-url': { type: 'string' },
        'public-url': { type: 'string' },
        'secret-key': { type: 'string' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }))
  } catch (error) {
    io.err(`${c.red}${(error as Error).message}${c.reset}`)
    io.err(HELP)
    return 1
  }

  if (values.version) {
    io.out(`bellhop ${packageVersion()}`)
    return 0
  }
  const command = positionals[0]
  if (values.help) {
    io.out(HELP)
    return 0
  }
  if (!command) {
    io.err(HELP)
    return 1
  }

  const secretKey = (values['secret-key'] as string | undefined) ?? env.BELLHOP_SECRET_KEY
  if (!secretKey) {
    io.err('Set BELLHOP_SECRET_KEY, or pass --secret-key.')
    return 1
  }

  // PUBLIC_URL as well, because an application with one public URL usually
  // calls it that, and a wrong pairing host is what doctor exists to catch.
  const publicUrl =
    (values['public-url'] as string | undefined) ??
    env.BELLHOP_PUBLIC_URL ??
    env.PUBLIC_URL ??
    'http://localhost:3000'
  const dbPath = (values.db as string | undefined) ?? env.BELLHOP_DB

  const bellhop = new Bellhop({
    secretKey,
    publicUrl,
    apiUrl: (values['api-url'] as string | undefined) ?? env.BELLHOP_API_URL,
    store: dbPath ? sqliteStore(dbPath) : undefined,
    fetch: deps.fetch,
    autoRenew: false,
  })

  try {
    switch (command) {
      case 'doctor':
        return await doctor(bellhop, dbPath, io, c)
      case 'pair':
        return await pair(bellhop, positionals[1], dbPath, io, c)
      case 'agents':
        return await agents(bellhop, io, c)
      default:
        io.err(`Unknown command: ${command}`)
        io.err(HELP)
        return 1
    }
  } catch (error) {
    if (!(error instanceof LicensingError)) throw error
    io.err(`\n  ${c.red}${error.code}${c.reset} (HTTP ${error.status}): ${error.message}\n`)
    if (/certificate|self.signed|UNABLE_TO_VERIFY/i.test(error.message)) {
      io.err(
        `  Node ignores the OS trust store by default. If this host's certificate\n` +
          `  comes from there, re-run with --use-system-ca.\n`
      )
    }
    return 1
  } finally {
    await bellhop.close()
  }
}

type Colours = { green: string; red: string; dim: string; bold: string; reset: string }

async function doctor(
  bellhop: Bellhop,
  dbPath: string | undefined,
  io: CliIo,
  c: Colours
): Promise<number> {
  const report = await bellhop.doctor()
  // Without a database this process's store is empty, so its agent and
  // credential lines would describe nothing.
  const checks = dbPath
    ? report.checks
    : report.checks.filter((check) => check.name !== 'agents' && check.name !== 'credentials')
  io.out('')
  for (const check of checks) {
    const mark = check.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`
    io.out(`  ${mark} ${c.bold}${check.name}${c.reset}  ${check.detail}`)
    if (check.remedy) io.out(`      ${c.dim}${check.remedy}${c.reset}`)
  }
  io.out(
    dbPath
      ? `  ${c.dim}The agent and credential lines describe ${dbPath}.${c.reset}\n`
      : `  ${c.dim}Pass --db <file> to check the agents and credentials in your database too.${c.reset}\n`
  )
  return checks.every((check) => check.ok) ? 0 : 1
}

async function pair(
  bellhop: Bellhop,
  label: string | undefined,
  dbPath: string | undefined,
  io: CliIo,
  c: Colours
): Promise<number> {
  if (!label) {
    io.err('Usage: bellhop pair "Shipping Desk" --db bellhop.db')
    return 1
  }
  if (!dbPath) {
    // Creating the agent takes a slot on the plan, and a link only works if
    // the claim lands in the same database the server reads.
    io.err(
      'bellhop pair needs the database your server uses: pass --db <file> or set BELLHOP_DB.\n' +
        'Otherwise the link cannot be claimed. From application code, call bellhop.agents.create() instead.'
    )
    return 1
  }

  const { agent, pairingLink } = await bellhop.agents.create({ label })
  io.out(`
  Agent ${c.bold}${agent.label}${c.reset} created (bellhop.dev agent ${agent.remoteId}) in ${dbPath}.

  Open this on the computer at that location:

    ${pairingLink}

  ${c.dim}Single use, and it expires. It contains a bearer credential, so treat it
  like one: do not paste it into a ticket or a chat that outlives the pairing.${c.reset}
`)
  return 0
}

async function agents(bellhop: Bellhop, io: CliIo, c: Colours): Promise<number> {
  const { agents } = await bellhop.licensing.listAgents()
  if (agents.length === 0) {
    io.out('\n  No agents registered for this app.\n')
    return 0
  }
  io.out('')
  for (const agent of agents) {
    const colour = agent.status === 'active' ? c.green : agent.status === 'pending' ? '' : c.dim
    io.out(
      `  ${String(agent.id).padStart(4)}  ${colour}${agent.status.padEnd(12)}${c.reset}${agent.label}`
    )
  }
  io.out('')
  return 0
}

/** The convention picocolors and chalk follow. */
function wantsColour(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  return env.TERM !== 'dumb' && process.stdout.isTTY === true
}

function packageVersion(): string {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  return pkg.version
}
