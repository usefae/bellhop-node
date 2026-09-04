# @usefae/bellhop-node

Print to the label printers and read the USB scales at a physical location,
from your Node application. The connection runs from your server to the
machine at that location, and nothing sits in the middle of it.

You need an app on [bellhop.dev](https://bellhop.dev). That is where agents
are licensed and where your secret key comes from.

```bash
npm install @usefae/bellhop-node
```

## The whole thing

```ts
import express from 'express'
import { Bellhop } from '@usefae/bellhop-node'
import { bellhopExpress } from '@usefae/bellhop-node/express'
import { attachWebSocket } from '@usefae/bellhop-node/ws'
import { sqliteStore } from '@usefae/bellhop-node/sqlite'

const bellhop = new Bellhop({
  secretKey: process.env.BELLHOP_SECRET_KEY!,
  publicUrl: 'https://deliver.example.com',
  store: sqliteStore('bellhop.db'),
})

const app = express()
app.use(bellhopExpress(bellhop))   // claim, the webhook, and the HTTP transport
const server = app.listen(3000)
attachWebSocket(bellhop, server)   // the WebSocket transport

// Add a location, then put the link in front of whoever is at the desk.
const { agent, pairingLink } = await bellhop.agents.create({ label: 'Shipping Desk' })

// Print to it.
await bellhop.print(agent.id, { kind: 'label', format: 'zpl', data: zpl })

// Hear back from it.
bellhop.on('weight', ({ agentId, grams }) => fillShippingForm(agentId, grams))
bellhop.on('ack', ({ jobId, status, error }) => recordOutcome(jobId, status, error))
bellhop.on('error', (error) => report(error))
```

That is a complete Bellhop server. Pairing, both transports, keepalive,
redelivery, credential renewal, and the licensing calls are all in there.
Renewal starts when a transport attaches; `autoRenew: false` hands it to your
own job runner instead.

Two settings matter.

`secretKey` is on your app's page on bellhop.dev. Keep it out of source.

`publicUrl` is your application's public base URL. Its host is the **pairing
host**: it goes in every pairing link, every credential is bound to it, and
the agent compares it byte for byte. Pick it once. Changing it after agents
have paired means all of them re-pair. Your socket can live on another host;
the `transports` block in the claim response is for that.

Node 20.11 or later. Every option, method, event, and error is listed in
[API.md](API.md).

## When it does not pair

```bash
npx @usefae/bellhop-node doctor
```

It checks the secret key, the plan and its agent slots, the pairing host, the
signing keys the agent must trust, whether a webhook is registered, and TLS.
Every one of those failures looks the same from the outside. Start here.
Inside a project that has the package installed, `npx bellhop doctor` works
too, and `--db bellhop.db` adds the agents and credentials in your database
to the report.

## Printing

`kind` is yours. The agent shows it in its recent-activity list and does
nothing else with it. Formats are `zpl`, `pdf`, `gif`, and `raw`. Raw
delivers any byte stream to the queue untouched: ESC/POS receipts, EPL,
whatever your hardware speaks.

```ts
// Inline. Right for ZPL: it is text, and a string is encoded for you.
await bellhop.print(id, { kind: 'label', format: 'zpl', data: '^XA…^XZ' })

// By URL. Right for PDFs. The agent sends no credentials, so the URL carries
// its own. The callback runs once the job id exists, so a signed URL can
// name it.
await bellhop.print(id, {
  kind: 'packing_slip',
  format: 'pdf',
  url: (jobId) => signedUrl(`/documents/${jobId}`),
})

// Name a printer, and say how, when the desk's default is not what you want.
await bellhop.print(id, {
  kind: 'packing_slip',
  format: 'pdf',
  printer: 'Office_HP_LaserJet',
  options: { copies: 2, duplex: 'long-edge', paper: 'Letter' },
  url: (jobId) => signedUrl(`/documents/${jobId}`),
})
```

A job that names a `printer` goes to it, by the `id` from the agent's
inventory. A job that names none routes by format to the printer the operator
picked for labels or for documents. If the agent is offline the job stays
pending and goes out at its next handshake. Machines sleep overnight; that is
normal.

### The printers at that desk

Every `hello` carries the printers the operator shared with you, and what
each one can do. A later `hello` replaces the last one outright. The list is
all you learn about the hardware there: a printer nobody shared is not in it.

```ts
const agent = await bellhop.agents.get(agentId)
agent.printers        // [{ id, name, capabilities: { papers, bins, dpi, duplex, color } }]
agent.defaultPrinters // { label: 'Zebra_ZP450', document: 'Office_HP_LaserJet' }
```

Target with `id`, never with `name`. Display names are neither unique nor
stable. A capability is present when the agent could read it and absent when
it could not. A driver with no duplex feature reports `duplex: false`; a queue
the agent could not read at all reports `capabilities: {}` and takes no
printer options.

### Options

`options` is a closed set: `copies`, `duplex`, `paper`, `bin`, `dpi`,
`color`, `pages`, `rotate`, `fit`, `collate`, `nup`. An option you leave out
means whatever the printer does by default. A name outside the set is an
error, since a misspelled `duplx` dropped quietly would be a single-sided
document acked as printed. `zpl` and `raw` take `copies` and nothing else;
`duplex`, `pages`, `collate`, and `nup` are `pdf` only.

Anything the library can check without an agent, it checks before a job
exists, and throws an `AgentError` at your own line: an inline document over
50 MB, a format the agent has not advertised, a printer its last `hello` did
not report, an option that does not exist or does not apply to the format, a
value outside its range, a malformed page range. Each carries a `code`
(`document_too_large`, `unsupported_format`, `unknown_printer`,
`invalid_option`, and so on) so your code never has to read the sentence.
What only the desk can know (does that laser printer hold Letter?) the agent
checks before printing and reports in the ack, with an `errorCode` your code
can branch on.

## Where it runs

| Host | Import |
|---|---|
| Express | `bellhopExpress(bellhop)` from `@usefae/bellhop-node/express` |
| Fastify | `bellhopFastify` from `@usefae/bellhop-node/fastify` |
| Hono, Next.js, Workers, Deno, Bun, Lambda | `bellhopFetch(bellhop)` from `@usefae/bellhop-node/web` |
| Anything else | `bellhop.handleRequest(request)`, about thirty lines to adapt |

The WebSocket transport needs a long-lived process, so it is a separate
import (`@usefae/bellhop-node/ws`) that serverless deployments never pull in. Where
a socket cannot be held, the HTTP transport carries the same messages. On a
platform that will not hold a request open either, set `pollSeconds: 0`. The
agent then polls every 3 seconds, and a label comes out within 3 seconds of
being created. Nobody standing at a printer notices that.

The fetch adapter reads the client address from `x-forwarded-for` or
`cf-connecting-ip`. Where neither exists, the claim endpoint's rate limiter
steps aside and says so once in the log, rather than putting every caller in
one bucket.

## Hearing about failures

Anything that goes wrong in the background, such as a store write failing
after a print was handed over, is emitted as the `error` event. Subscribe to
it. When nothing is subscribed, the failure goes to the `logger` you passed,
or to the console when there is none, so it is never silent.

## Plan changes

Entitlements live in the credential and are read when it is minted. On its
own, a plan change waits for the next renewal.

Register `https://deliver.example.com/bellhop/webhook` on your app's page on
bellhop.dev and the wait goes away. bellhop.dev calls when the plan changes,
the route verifies the delivery against the published signing keys, and
every paired agent is pushed a credential with the new entitlements.
bellhop.dev also calls when an agent is removed there, and the library
retires it here too: connection closed, record gone. There is no webhook
secret to hold. Behind it are `bellhop.refresh()` and
`bellhop.retireDeactivated()`, which you can also call by hand.

## Storage

The default is `memoryStore()`, which is right for tests and lost on
restart. `sqliteStore('bellhop.db')` installs nothing. It needs Node 22.5 or
later and says so at startup on anything older; some Node versions print a
one-line experimental warning when the SQLite module loads, which is
harmless. For your own database, implement `Store`. Everything above it works
unchanged.

Three things any implementation must preserve. A job id is never reused,
because the agent deduplicates on it. Digests are stored rather than tokens.
Updates are patches, where an absent key means "leave it alone". The
conformance suite in the repository's `test` directory checks all of that
against both shipped stores and can be pointed at yours.

## Running more than one process

`inProcessPubSub()` is the default and is enough for a single process. Beyond
that, a print job created by one worker has to reach a socket held by
another. Implement `PubSub` over Redis:

```ts
const pubsub: PubSub = {
  publish: (agentId, message) =>
    redis.publish('bellhop', JSON.stringify({ agentId, message })),
  subscribe(deliver) {
    sub.subscribe('bellhop')
    sub.on('message', (_, raw) => {
      const { agentId, message } = JSON.parse(raw)
      deliver(agentId, message)
    })
  },
  close: () => Promise.all([redis.quit(), sub.quit()]),
}
```

Whichever process holds the connection writes to it and marks the job
`sent`; the rest no-op. `bellhop.close()` calls `close` on the pubsub and
the store. The HTTP transport does not need the pubsub at all. Its queue
lives in the store, so any process can write to it and any process can
serve a poll. Non-sticky load balancing and serverless both work.

Presence is shared the same way. `agents.isOnline()` and `agents.onlineIds()`
(async since 0.3.0) answer from this process's connections plus the store's
`lastSeenAt` within three heartbeats, so they are correct wherever the store
is shared. If a store read per check is too hot, implement `Presence` over
Redis and pass it as `presence`.

`lastSeenAt` is written in batches, once per heartbeat interval per process
rather than once per message, so it is fresh to within one interval. A
`hello` writes through immediately. Implement the optional `touchAgents`
store method as a single `UPDATE … WHERE id IN (…)` and each flush is one
statement.

## Testing

Printing to a real agent is the right way to check that a label comes out.
For CI, where there is no agent and no bellhop.dev, `@usefae/bellhop-node/testing`
has both:

```ts
import { fakeAgent, fakeLicensing } from '@usefae/bellhop-node/testing'

const licensing = fakeLicensing()
const bellhop = new Bellhop({
  secretKey: 'test',
  publicUrl: 'http://localhost:3000',
  fetch: licensing.fetch,
})

const { claimToken } = await bellhop.agents.create({ label: 'Test' })
const agent = await fakeAgent(bellhop, { claimToken })

await bellhop.print(agent.agentId, { kind: 'label', format: 'zpl', data: zpl })
await agent.waitForPrint()

expect(agent.printed).toHaveLength(1)
expect(agent.printed[0].data.toString()).toContain('^XA')
```

`fakeLicensing()` answers every licensing route offline, so no plan slot is
taken and no network is touched. Its `state` holds counters (`activations`,
`renewals`) and switches (`failActivation`, `failKeys`), and `signWebhook()`
produces a delivery your webhook route will accept.

`fakeAgent` speaks the protocol the way the real agent does. It deduplicates
by job id and answers `ping`. `failPrints` exercises your error path,
`capabilities` exercises the gate on formats an agent cannot handle, and
`printers` shapes the inventory it advertises: two label printers, a queue
whose driver could not be read (`capabilities: {}`), or a desk that shares
nothing. `waitForPrint()` and `waitForAck()` resolve when the job lands. Each
entry in `printed` carries the `printer` and `options` the job named.

```ts
const agent = await fakeAgent(bellhop, {
  claimToken,
  printers: [{ id: 'Front_Zebra', name: 'Front Zebra', capabilities: { duplex: false } }],
})

await bellhop.print(agent.agentId, {
  kind: 'label',
  format: 'zpl',
  printer: 'Front_Zebra',
  options: { copies: 2 },
  data: zpl,
})
await agent.waitForPrint()

expect(agent.printed[0].options).toEqual({ copies: 2 })
```

## What it will not do

**Validate inbound messages against the schemas.** Both sides ignore what
they do not recognise. That rule is the protocol's only forward-compatibility
mechanism, and enforcing schemas would break it. Messages this library sends
are schema-tested in CI.

**Log tokens.** Claim tokens, agent tokens, credentials, and the
`Authorization` header stay out of log lines. `agents.create()` logs that a
link was issued, never the link, because the link is the claim token.

**Redeliver on every `hello`.** A `hello` arrives mid-session whenever an
operator changes a printer. Re-sending outstanding jobs each time can outrun
the agent's deduplication ledger and print the same label several times. Only
the first `hello` on a connection redelivers. A reconnect is a new
connection, so at-least-once delivery still holds.

## Reference

[API.md](API.md) lists every option, method, event, error, and entry point.
[CHANGELOG.md](CHANGELOG.md) has what changed. [SECURITY.md](SECURITY.md)
says how to report a vulnerability, and [CONTRIBUTING.md](CONTRIBUTING.md)
how to work on the code.

The protocol reference at https://bellhop.dev/docs/protocol is normative.
Where this library disagrees with it, the library is wrong. The integration
guide is at https://bellhop.dev/docs.

MIT licence.
