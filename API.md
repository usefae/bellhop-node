# @usefae/bellhop-node API

Everything the package exports, by entry point. The README explains how the
pieces fit; this lists them.

## `new Bellhop(options)`

From `@usefae/bellhop-node`. One per application.

| Option | Type | Default | What it does |
|---|---|---|---|
| `secretKey` | `string` | required | Your app's secret key from bellhop.dev. |
| `publicUrl` | `string` | required | This application's public base URL. Its host is the pairing host. HTTPS, except on localhost. |
| `store` | `Store` | `memoryStore()` | Where agents, jobs, and HTTP sessions live. |
| `apiUrl` | `string` | `https://bellhop.dev` | The licensing API. |
| `appName`, `accentColor` | `string` | from bellhop.dev | Branding shown by the agent before it activates. |
| `basePath` | `string` | `/bellhop` | Where the routes are mounted. `/` mounts at the root. |
| `heartbeatSeconds` | `number` | `20` | Requested agent keepalive. The agent clamps it to 5 to 120. |
| `pollSeconds` | `number` | `25` | How long the HTTP transport holds a poll. `0` returns at once and the agent polls every 3 seconds. |
| `claimTtlMs` | `number` | one hour | How long a pairing link stays usable. |
| `renewWithinDays` | `number` | a comfortable margin | How far ahead of expiry a credential is renewed. |
| `autoRenew` | `boolean` | `true` | Start renewing when a transport attaches. |
| `pubsub` | `PubSub` | `inProcessPubSub()` | Cross-process fanout. |
| `presence` | `Presence` | store-backed | How online and offline are answered. |
| `claimRateLimit` | `{ max, windowMs } \| false` | 10 per minute | Attempts per client address against the claim endpoint. |
| `logger` | `Logger` | silent | Anything with `info`, `warn`, and `error`. Tokens are redacted before a line is written. |
| `fetch`, `now` | | globals | Injected in tests. |

Bad configuration throws a `ConfigurationError` from the constructor.

### Properties

`config` is the resolved configuration (`ResolvedConfig`), including
`serverHost`, `socketUrl`, and `httpUrl`. `store` and `licensing` are the
instances in use.

### Agents

`bellhop.agents.create({ label, idempotencyKey? })` creates the agent on
bellhop.dev, where the plan's cap is enforced, and returns
`{ agent, pairingLink, claimToken }`. Send the same `idempotencyKey` for a
retry of the same creation.

`bellhop.agents.get(id)`, `bellhop.agents.list()`.

`bellhop.agents.isOnline(id)` and `bellhop.agents.onlineIds()`, both async,
answered by `presence`.

`bellhop.agents.repair(id)` returns a fresh pairing link. Claiming it rotates
the agent token and disconnects the machine holding the old one.

`bellhop.agents.remove(id)` closes the connection with 4003, frees the slot
on bellhop.dev, and deletes the record.

### Printing

`bellhop.print(agentId, input)` returns the `JobRecord`. `input`:

| Field | Type | Notes |
|---|---|---|
| `kind` | `string` | Yours. Shown in the agent's recent-activity list. |
| `format` | `'zpl' \| 'raw' \| 'pdf' \| 'gif'` | Decides the route when no `printer` is named. |
| `printer` | `string` | A printer `id` from the agent's last `hello`. |
| `options` | `PrintOptions` | `copies`, `duplex`, `paper`, `bin`, `dpi`, `color`, `pages`, `rotate`, `fit`, `collate`, `nup`. |
| `data` | `string \| Buffer \| Uint8Array` | Inline document, at most 50 MB. A string is UTF-8. |
| `url` | `string \| (jobId) => string \| Promise<string>` | Where the agent fetches the document. A function runs once the job id exists. |

Exactly one of `data` and `url`. Anything the library can refuse without an
agent is refused here as an `AgentError`.

`bellhop.jobs.get(id)`, `bellhop.jobs.recent(limit = 20)`,
`bellhop.jobs.outstanding(agentId)`.

### Renewal and plan changes

`bellhop.renew()` re-mints credentials that expire soon and returns
`{ renewed, failed }`. `bellhop.startRenewals(everyMs?)` runs it on an
interval; every transport calls this when it attaches unless
`autoRenew: false`. `bellhop.refresh()` re-mints every paired agent now,
which is how a plan change reaches the fleet; concurrent calls coalesce.
`bellhop.retireDeactivated()` removes every local agent bellhop.dev lists as
deactivated and returns `{ retired }`.

### Requests

`bellhop.handleRequest(request)` serves every route the library owns from a
transport-neutral `BellhopRequest` and returns a `BellhopResponse`. The
adapters are thin translations onto it. `bellhop.transports()` is the list
sent in a claim response. `bellhop.pairingLink(claimToken)` builds the
`bellhop://pair` link. `bellhop.authenticate(authorization)` resolves a
bearer token to an `AgentRecord`, for a transport of your own.

### Events

`bellhop.on(event, listener)`, `off`, and `once`, typed by `BellhopEvents`.

| Event | Payload |
|---|---|
| `hello` | `{ agentId, agentVersion, platform, capabilities, printers, defaultPrinters, isHandshake }` |
| `print` | `{ agentId, jobId, kind, format, printer }` when a job is handed to a live connection |
| `ack` | `{ agentId, jobId, status, error, errorCode }` |
| `weight` | `{ agentId, grams, stable }` |
| `event` | `{ agentId, code, message, at }` |
| `online`, `offline` | `{ agentId }` |
| `error` | an `Error` from background work |

When nothing listens for `error`, the failure goes to `logger.error`, or to
the console when there is no logger.

### Diagnostics and lifecycle

`bellhop.doctor()` returns `{ ok, checks }`, each check
`{ name, ok, detail, remedy? }`. `bellhop.close({ retryAfterSeconds? })`
closes every connection with 1001, then the pubsub, presence, and store.

## Errors

Every error extends `BellhopError`, which extends `Error` and carries a
string `code`.

| Class | `code` | When |
|---|---|---|
| `ConfigurationError` | `missing_secret_key`, `missing_public_url`, `invalid_public_url`, `unsupported_node` | Construction, or `sqliteStore()` on a Node without `node:sqlite`. |
| `AgentError` | `agent_not_found`, `invalid_input`, `unknown_printer`, `unsupported_format`, `invalid_option`, `document_too_large` | `print()` refused the job. Also carries `agentId`. |
| `LicensingError` | bellhop.dev's code, or `unreachable` | A licensing call failed. Carries `status`, `body`, `retryable`, `operatorMessage`, and `cause`. |

## Entry points

| Import | Exports | Needs |
|---|---|---|
| `@usefae/bellhop-node` | `Bellhop`, the errors, `memoryStore`, `inProcessPubSub`, `LicensingClient`, `WebhookVerifier`, `parseSignatureHeader`, `CloseCodes`, `PROTOCOL_VERSION`, and every type | |
| `@usefae/bellhop-node/express` | `bellhopExpress(bellhop)`, `bellhopExpressHandler(bellhop)` | `express` |
| `@usefae/bellhop-node/fastify` | `bellhopFastify` plugin, registered with `{ bellhop }` | `fastify` |
| `@usefae/bellhop-node/web` | `bellhopFetch(bellhop)`: `(Request) => Promise<Response>` | |
| `@usefae/bellhop-node/ws` | `attachWebSocket(bellhop, server, { path? })`, returns a detach function | `ws` |
| `@usefae/bellhop-node/sqlite` | `sqliteStore(filename = 'bellhop.db')` | Node 22.5 |
| `@usefae/bellhop-node/testing` | `fakeAgent(bellhop, options)`, `fakeLicensing(overrides?)` | |

## Seams

`Store` is documented on the interface itself. `PubSub` has `publish`,
`subscribe`, and an optional `close`. `Presence` has `isOnline`, `onlineIds`,
and an optional `close`. `Connection` is what a transport hands to
`bellhop.receive()`.

## The `bellhop` command

`npx @usefae/bellhop-node <command>`, or `npx bellhop <command>` inside a project
that has the package installed.

| Command | Does |
|---|---|
| `doctor` | Checks the environment and exits 1 if anything fails. |
| `pair <label>` | Creates an agent in the database given by `--db` and prints its pairing link. |
| `agents` | Lists the agents bellhop.dev knows for this app. |

Options `--secret-key`, `--public-url`, `--api-url`, and `--db`, each with an
environment variable: `BELLHOP_SECRET_KEY`, `BELLHOP_PUBLIC_URL` (or
`PUBLIC_URL`), `BELLHOP_API_URL`, `BELLHOP_DB`. `--help` and `--version`.
Colour follows `NO_COLOR`, `FORCE_COLOR`, and whether stdout is a terminal.
