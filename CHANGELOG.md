# Changelog

## 1.0.0 - 2026-09-04

Renewal is automatic. Attaching any transport (`attachWebSocket`,
`bellhopExpress`, `bellhopFastify`, `bellhopFetch`) starts the renewal timer,
so credentials stay fresh without `startRenewals()` being called or a job
being scheduled. `autoRenew: false` restores the manual arrangement for
applications with their own job runner. `startRenewals()` and `renew()` are
unchanged.

Every adapter answers `POST <basePath>/webhook`, the URL to register on your
app's page on bellhop.dev. A verified `app.entitlements_changed` delivery
re-mints every paired agent's credential and pushes it, so a plan change
reaches the fleet in moments. A verified `agent.deactivated` delivery retires
the removed agents locally: connection closed, record gone, as
`bellhop.agents.remove` would leave them. Deliveries are signed with the same
published Ed25519 keys that sign credentials, so there is no webhook secret.
Behind it: `bellhop.refresh()` and `bellhop.retireDeactivated()`, both also
callable by hand (refresh coalesces concurrent runs); `WebhookVerifier` and
`parseSignatureHeader`, exported for custom routing; and a `webhook` line in
the doctor.

Agents report their printers, and a job may name one. `hello` carries the
printers the operator shared with this pairing, each with a stable id, a
display name, and a capabilities object, plus a `default_printers` role map.
`bellhop.print()` takes `printer` to target one. An id the agent's most recent
`hello` did not report is refused rather than sent.

Print options: `copies`, `duplex`, `paper`, `bin`, `dpi`, `color`, `pages`,
`rotate`, `fit`, `collate`, and `nup`, as a closed set. An option that does
not exist, does not apply to the job's `format`, or holds a value outside its
range is refused at the call site, page ranges included. Everything about a
particular printer stays the agent's to enforce and comes back in the `ack`.

A `raw` format, delivered to the queue untouched like `zpl`. It is for
ESC/POS, EPL, and anything else with no filter in the way, and it routes to
the `label` role.

The `ack` event carries `errorCode`, the machine-readable failure class the
agent sends beside the sentence. Branch on it rather than on the wording of
`error`. A code you do not recognise means a plain failure.

`agents.create()` and `licensing.createAgent()` take an optional
`idempotencyKey`, sent as an `Idempotency-Key` header, so a retried create
cannot leave a second agent holding a slot on your plan.

Errors carry codes. `AgentError.code` says why `print()` refused a job
(`unknown_printer`, `unsupported_format`, `invalid_option`,
`document_too_large`, `invalid_input`, `agent_not_found`),
`ConfigurationError.code` says what is wrong with the configuration, and a
`LicensingError` raised for an unreachable host keeps the original failure
as `cause`. `BellhopError` is the base of all three.

`@usefae/bellhop-node/testing` exports `fakeLicensing()`, a stand-in for bellhop.dev
that answers every licensing route offline, so a consumer's CI can pair a
`fakeAgent` without a key or a network. `fakeAgent` gains `waitForAck()`.

Failures in background work are no longer silent. When nothing listens for
the `error` event they go to `logger.error`, or to the console when there is
no logger. `redact()` keeps an Error's name, message, and stack.

The CLI: `--version`, `--help` exits 0, colour follows `NO_COLOR`,
`FORCE_COLOR`, and the terminal, and the documented invocation is
`npx @usefae/bellhop-node doctor` (the bare name `bellhop` belongs to an unrelated
package on npm). `pair` needs `--db <file>` or `BELLHOP_DB` and refuses
otherwise, because a link minted into an in-memory store could never be
claimed and still took a slot on the plan. Without `--db`, `doctor` no longer
prints agent and credential lines about an empty store.

Transport hardening. The WebSocket upgrade path handles a socket reset during
the token lookup and a failing store, both of which were process crashes; a
socket that never says `hello` is dropped; and a socket that has gone quiet
for three heartbeats is terminated so a half-open connection cannot keep an
agent "online" and swallow prints (PROTOCOL.md §6). An HTTP session's grace
timer is cleared on shutdown, and a store write failing after `close()` no
longer surfaces as an unhandled rejection. Local session handles that another
process already reaped are swept. An explicit `wait=0` on a poll is honoured,
and the wait is capped at `pollSeconds`. The claim rate limiter steps aside
with a warning when an adapter supplies no client address, rather than
putting every caller in one bucket, and its memory is bounded. The webhook
verifier refreshes a key set after ten minutes even when it knows the kid, so
a withdrawn key stops verifying, and shares one fetch among concurrent
deliveries. `sqliteStore` sets a busy timeout for multi-process use and
applies migrations only where a column is missing, so a real failure
surfaces instead of being swallowed.

Packaging. Each entry point now declares its types per condition, so a
CommonJS TypeScript consumer gets CommonJS declarations (`publint` and
`arethetypeswrong` both pass). CJS output is split into shared chunks, so a
class such as `ConfigurationError` is one object however many subpaths are
required. `package.json` gains `main`, `module`, `types`, `author`,
`homepage`, and `publishConfig`. The Fastify adapter registers the webhook
route, which was documented but missing, and declares plugin metadata so
`app.hasPlugin('@usefae/bellhop-node')` answers. The Express adapter's JSON body
limit is 1 MB, matching Fastify's default. The adapters are tested against
Express 4 and 5 and Fastify 4 and 5, which is what the peer ranges claim. `sqliteStore()` on a Node older
than 22.5 throws a `ConfigurationError` that says so instead of failing to
import.

**Breaking for custom stores.** `enqueueSessionMessages` takes and
`drainSessionMessages` returns `ServerMessage[]` rather than `unknown[]`.
`PubSub` and `Presence` may define `close()`, which `bellhop.close()` calls.

**Breaking for custom stores.** `AgentRecord.printers` is now `Printer[]`
rather than a role map, `AgentRecord.defaultPrinters` is new, and `JobRecord`
and `createJob` gain `printer` and `options`. `sqliteStore` migrates itself:
three added columns, and a `printers` value written by an earlier version
reads as an empty inventory that the next `hello` replaces.

**Breaking for `hello` listeners.** The event's `printers` is the new array,
with `defaultPrinters` beside it. The `print` event gains `printer`, null when
the job routes by format.

## 0.3.0 - 2026-08-09

Multi-process deployments work as documented. `deliver()` no longer gates
publishing on this process's socket map, which was the bug that broke the
README's Redis recipe. Whichever process holds the connection writes to it and
marks the job `sent`; everyone else no-ops.

**Breaking: `agents.isOnline()` and `agents.onlineIds()` are async.** They
answer from this process's connections plus the store's `lastSeenAt` within
three heartbeats, so they are correct across processes wherever the store is
shared. Override with the new `presence` option if a store read per check is
too hot.

**Breaking for custom stores: the HTTP session queue lives in the Store.**
`SessionRecord` gains `handshakeComplete`; implementations must add
`findLiveSessionByAgent`, `updateSession`, `enqueueSessionMessages`, and
`drainSessionMessages` (atomic), and `deleteSession` must discard the queue.
In exchange, any process can enqueue to a session and any process can serve
its polls, so non-sticky load balancing and serverless both work. The optional
`touchAgents` method turns each presence flush into one statement.

`lastSeenAt` is written in batches, once per heartbeat interval per process
rather than once per message. `hello` writes through immediately. The
per-message agent-record read is gone; the record is cached per connection.

Retryable closes can carry `retry_after_seconds`, the reconnect pacing hint of
PROTOCOL.md §7.3, and `bellhop.close({ retryAfterSeconds })` spreads a
deploy's reconnect wave.

`sqliteStore` databases migrate automatically: one added column, one added
table.

## 0.2.0

**Breaking: "station" is now "agent" everywhere.** bellhop.dev counts agents
and the installed application calls itself an agent, but the library called
your record of it a station. One concept, one word.

| 0.1.x | 0.2.0 |
|---|---|
| `bellhop.stations.*` | `bellhop.agents.*` |
| `bellhop.print(stationId, ...)` | `bellhop.print(agentId, ...)` |
| `StationRecord`, `StationPatch` | `AgentRecord`, `AgentPatch` |
| `StationError` | `AgentError` |
| `{ stationId }` in every event | `{ agentId }` |
| `Store.createStation` and friends | `Store.createAgent` and friends |
| `bellhop_stations` table | `bellhop_agents` |

`RemoteAgent` is unchanged: it is still the shape bellhop.dev returns.

A custom `Store` implementation needs its method names updated. `sqliteStore`
creates `bellhop_agents`; an existing database needs:

```sql
alter table bellhop_stations rename to bellhop_agents;
alter table bellhop_jobs rename column station_id to agent_id;
alter table bellhop_sessions rename column station_id to agent_id;
```

Nothing on the wire changed. The protocol never used the word, so agents
already paired keep working and no machine has to re-pair.

## 0.1.0

First release.
