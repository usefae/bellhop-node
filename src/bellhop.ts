import { EventEmitter } from 'node:events'
import { resolveConfig, type BellhopOptions, type Logger, type ResolvedConfig } from './config.js'
import { LicensingClient } from './licensing.js'
import { WebhookVerifier } from './webhooks.js'
import { LicensingError, AgentError } from './errors.js'
import {
  inProcessPubSub,
  Registry,
  type Connection,
  type Presence,
  type PubSub,
} from './connections.js'
import {
  handleAgentMessage,
  readDefaultPrinters,
  readPrinters,
  type SessionHost,
} from './session.js'
import { HttpSession } from './http-session.js'
import { runDoctor, type DoctorReport } from './doctor.js'
import { compactPrintOptions, refusePrintOptions } from './options.js'
import { memoryStore } from './store/memory.js'
import type { JobRecord, AgentRecord, Store } from './store/types.js'
import { bearerToken, digest, randomToken, rateLimiter, redact, secureEquals } from './security.js'
import {
  PROTOCOL_VERSION,
  type AckErrorCode,
  type AgentMessage,
  type ClaimResponse,
  type HelloMessage,
  type Printer,
  type PrintFormat,
  type PrintOptions,
  type ServerMessage,
  type TransportDescriptor,
} from './types.js'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface BellhopEvents {
  /**
   * An agent completed or refreshed its handshake. `printers` is the whole
   * inventory as of this `hello`, which replaces the last one.
   */
  hello: {
    agentId: string
    agentVersion: string
    platform: string
    capabilities: string[]
    printers: Printer[]
    defaultPrinters: Record<string, string>
    isHandshake: boolean
  }
  /**
   * A job finished. `printed` means the document reached the print system;
   * paper may still not have come out. Branch on `errorCode` rather than on
   * the wording of `error`.
   */
  ack: {
    agentId: string
    jobId: string
    status: 'printed' | 'failed'
    error: string | null
    errorCode: AckErrorCode | null
  }
  /** The operator weighed something. Already debounced by the agent. */
  weight: { agentId: string; grams: number; stable: boolean }
  event: { agentId: string; code: string; message: string | null; at: string | null }
  online: { agentId: string }
  offline: { agentId: string }
  /** A print was handed to a live connection. `printer` is null when it routes by format. */
  print: {
    agentId: string
    jobId: string
    kind: string
    format: PrintFormat
    printer: string | null
  }
  error: Error
}

export interface PrintInput {
  /** Yours, and opaque to the agent: `label`, `packing_slip`. */
  kind: string
  /**
   * `zpl`, `raw`, `pdf`, or `gif`. Decides where the job goes when it names no
   * `printer`: `pdf` to the `document` role, everything else to `label`.
   */
  format: PrintFormat
  /**
   * The `id` of a printer the agent shared, from `agents.get()` or the `hello`
   * event. An id the agent's last `hello` did not report is refused here.
   * Leave it out and the job routes by `format`.
   */
  printer?: string
  /**
   * `copies`, `duplex`, `paper`, `bin`, `dpi`, `color`, `pages`, `rotate`,
   * `fit`, `collate`, `nup`. All optional; an absent one means whatever that
   * printer does by default. An unknown name, a value outside its range, a
   * page range that does not parse, or an option that means nothing for this
   * `format` is refused here. Whether the target printer can honour the value
   * is the agent's answer, and arrives in the `ack`.
   */
  options?: PrintOptions
  /**
   * The document. A string is treated as text and encoded for you, which is
   * right for ZPL; pass a Buffer for anything binary. At most 50 MB decoded;
   * use `url` above that.
   */
  data?: Buffer | Uint8Array | string
  /**
   * Where the agent can fetch the document. The agent sends no credentials
   * with the request, so the URL must carry its own authorisation, such as a
   * signed object-storage URL. HTTPS, except on loopback.
   *
   * Pass a function when the URL has to contain the job id. It is called once,
   * after the job exists and before anything is delivered:
   *
   *   url: (jobId) => signedUrl(`/documents/${jobId}`)
   */
  url?: string | ((jobId: string) => string | Promise<string>)
}

export interface CreateAgentResult {
  agent: AgentRecord
  /**
   * Put this in front of the person at the desk: an email, or a button in your
   * admin. Single use, and it expires. It contains the claim token, which is a
   * bearer credential, so this library never logs it and yours should not
   * either.
   */
  pairingLink: string
  claimToken: string
}

/** Transport-neutral request, so one implementation serves every adapter. */
export interface BellhopRequest {
  method: string
  /** Path *relative to* `basePath`: `/claim`, `/sessions`, `/sessions/:id/messages`. */
  path: string
  query?: URLSearchParams
  getHeader(name: string): string | undefined
  body?: unknown
  ip?: string
}

export interface BellhopResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

// ---------------------------------------------------------------------------

const MAX_INLINE_BYTES = 50 * 1024 * 1024

export interface RenewalReport {
  renewed: string[]
  failed: { agentId: string; code: string }[]
}

/**
 * One Bellhop server: pairing, both transports, redelivery, renewal, and the
 * licensing calls. Create one per application and attach a transport.
 *
 *   const bellhop = new Bellhop({ secretKey, publicUrl, store: sqliteStore('bellhop.db') })
 *   app.use(bellhopExpress(bellhop))
 *   attachWebSocket(bellhop, server)
 */
export class Bellhop {
  readonly config: ResolvedConfig
  readonly store: Store
  readonly licensing: LicensingClient

  private readonly emitter = new EventEmitter()
  private readonly webhooks: WebhookVerifier
  private refreshRun: Promise<RenewalReport> | null = null
  private refreshNext: Promise<RenewalReport> | null = null
  private readonly registry: Registry
  private readonly pubsub: PubSub
  private readonly presence: Presence
  private readonly logger: Logger | undefined
  private readonly claimLimiter
  private readonly httpSessions = new Map<string, HttpSession>()
  private readonly agentCache = new WeakMap<Connection, AgentRecord>()
  private readonly lastInbound = new WeakMap<Connection, number>()
  private readonly warned = new Set<string>()
  private readonly sessionHost: SessionHost
  private readonly touched = new Set<string>()
  private touchesFlushedAt = 0
  private reaper: NodeJS.Timeout | undefined
  private renewalTimer: NodeJS.Timeout | undefined
  private closed = false
  private storeClosed = false

  constructor(options: BellhopOptions) {
    this.config = resolveConfig(options)
    this.store = options.store ?? memoryStore()
    this.logger = options.logger
    this.pubsub = options.pubsub ?? inProcessPubSub()
    this.claimLimiter =
      this.config.claimRateLimit === false ? null : rateLimiter(this.config.claimRateLimit)

    this.licensing = new LicensingClient({
      secretKey: this.config.secretKey,
      apiUrl: this.config.apiUrl,
      serverHost: this.config.serverHost,
      fetch: options.fetch,
    })

    this.webhooks = new WebhookVerifier(this.licensing, options.now)

    this.registry = new Registry((agentId, online) => {
      this.emitter.emit(online ? 'online' : 'offline', { agentId })
    })

    this.presence = options.presence ?? this.storePresence()

    // Everything outbound goes through the pubsub seam, even in the
    // single-process case, so there is one delivery path. The default calls
    // straight back into this handler.
    this.pubsub.subscribe((agentId, message) => {
      const connection = this.registry.get(agentId)
      if (!connection?.open) return
      connection.send(message)
      // Only the process that wrote to a live connection marks the job sent.
      if (message.type === 'print') {
        void this.store
          .updateJob(message.id, { status: 'sent', sentAt: Date.now() })
          .then(() => {
            this.emitter.emit('print', {
              agentId,
              jobId: message.id,
              kind: message.kind,
              format: message.format,
              printer: message.printer ?? null,
            })
          })
          .catch((error: Error) => this.emitter.emit('error', error))
      }
    })

    this.startSessionReaper()
    // Node throws on an 'error' emit with no listener. This one is registered
    // first, so a listener count of one means nobody else is listening, and
    // the failure goes to the logger, or the console, rather than nowhere.
    this.emitter.on('error', (error: Error) => {
      if (this.emitter.listenerCount('error') !== 1) return
      if (this.logger?.error) {
        this.log('error', 'unhandled error; subscribe with bellhop.on("error", ...)', { error })
      } else {
        console.error('[bellhop] unhandled error; subscribe with bellhop.on("error", ...):', error)
      }
    })

    this.sessionHost = this.buildSessionHost()
  }

  // -- events ---------------------------------------------------------------

  on<K extends keyof BellhopEvents>(event: K, listener: (payload: BellhopEvents[K]) => void): this {
    this.emitter.on(event, listener as (payload: unknown) => void)
    return this
  }

  off<K extends keyof BellhopEvents>(
    event: K,
    listener: (payload: BellhopEvents[K]) => void
  ): this {
    this.emitter.off(event, listener as (payload: unknown) => void)
    return this
  }

  once<K extends keyof BellhopEvents>(
    event: K,
    listener: (payload: BellhopEvents[K]) => void
  ): this {
    this.emitter.once(event, listener as (payload: unknown) => void)
    return this
  }

  // -- agents -------------------------------------------------------------

  readonly agents = {
    /**
     * Add a location. Creates the agent on bellhop.dev, where the plan's cap is
     * enforced, then mints a single-use pairing link. Pass `idempotencyKey`
     * when the call can be retried and the retry must not leave a second agent
     * holding a slot on the plan.
     */
    create: async (input: {
      label: string
      idempotencyKey?: string
    }): Promise<CreateAgentResult> => {
      const remote = await this.licensing.createAgent(input.label, {
        idempotencyKey: input.idempotencyKey,
      })
      const claimToken = randomToken(24)
      const agent = await this.store.createAgent({
        remoteId: remote.id,
        label: input.label,
        claimTokenDigest: digest(claimToken),
        claimExpiresAt: Date.now() + this.config.claimTtlMs,
      })
      this.log('info', `agent created`, { agentId: agent.id, remoteId: remote.id })
      return { agent, claimToken, pairingLink: this.pairingLink(claimToken) }
    },

    list: (): Promise<AgentRecord[]> => this.store.listAgents(),
    get: (id: string): Promise<AgentRecord | null> => this.store.findAgent(id),
    /**
     * True when any process holds this agent's connection. Async since 0.3.0,
     * because the answer lives in shared state.
     */
    isOnline: (id: string): Promise<boolean> => this.presence.isOnline(id),
    onlineIds: (): Promise<string[]> => this.presence.onlineIds(),

    /**
     * A fresh pairing link for an existing agent. Claiming it rotates the agent
     * token, which is how an agent moves to a new machine.
     */
    repair: async (id: string): Promise<CreateAgentResult> => {
      const claimToken = randomToken(24)
      const agent = await this.store.updateAgent(id, {
        claimTokenDigest: digest(claimToken),
        claimExpiresAt: Date.now() + this.config.claimTtlMs,
      })
      return { agent, claimToken, pairingLink: this.pairingLink(claimToken) }
    },

    /**
     * Remove a location. Refuses the agent's next connection with 4003, tells
     * it now if it is listening, and frees the slot on your plan. The
     * bellhop.dev call is best effort; a missed one leaves the slot used until
     * this is retried from a background job.
     */
    remove: async (id: string): Promise<void> => {
      const agent = await this.store.findAgent(id)
      if (!agent) return
      this.registry.close(id, 4003, 'This agent was removed.')
      try {
        await this.licensing.deactivate(agent.remoteId)
      } catch (error) {
        if (!(error instanceof LicensingError)) throw error
        this.log('warn', 'deactivation failed; the plan slot stays used', {
          agentId: id,
          code: error.code,
        })
      }
      await this.store.deleteAgent(id)
    },
  }

  /** `bellhop://pair?server=…&claim=…`. Never logged: the link is the token. */
  pairingLink(claimToken: string): string {
    const server = encodeURIComponent(this.config.publicUrl)
    return `bellhop://pair?server=${server}&claim=${encodeURIComponent(claimToken)}`
  }

  // -- printing -------------------------------------------------------------

  /**
   * Queue a document and push it if the agent is connected. Otherwise the job
   * stays pending and goes out at the next handshake. Machines sleep
   * overnight; that is normal.
   */
  async print(agentId: string, input: PrintInput): Promise<JobRecord> {
    const agent = await this.store.findAgent(agentId)
    if (!agent) throw new AgentError(`No agent ${agentId}`, agentId, 'agent_not_found')

    const hasData = input.data !== undefined
    if (hasData === (input.url !== undefined)) {
      throw new AgentError(
        'A print needs exactly one of `data` and `url`.',
        agentId,
        'invalid_input'
      )
    }

    // Refused in the order the agent resolves them (PROTOCOL.md §5.2.3):
    // target, format, options. Neither of the first two gates applies until
    // the agent has said something about itself; queueing for an agent that
    // has never connected is legitimate.
    if (input.printer !== undefined && agent.printers.length > 0) {
      if (!agent.printers.some((printer) => printer.id === input.printer)) {
        const shared = agent.printers.map((printer) => printer.id).join(', ')
        throw new AgentError(
          `Agent ${agentId} has not shared a printer called "${input.printer}". It shared: ${shared}`,
          agentId,
          'unknown_printer'
        )
      }
    }

    // A server must not send a print whose format has no matching capability
    // (PROTOCOL.md §4.1).
    if (agent.capabilities.length > 0 && !agent.capabilities.includes(`print:${input.format}`)) {
      throw new AgentError(
        `Agent ${agentId} does not advertise print:${input.format}. It offers: ${agent.capabilities.join(', ')}`,
        agentId,
        'unsupported_format'
      )
    }

    // What is wrong with `options` regardless of printer. Printer-specific
    // problems come back in the `ack`.
    if (input.options) {
      const problem = refusePrintOptions(input.options, input.format)
      if (problem) throw new AgentError(problem, agentId, 'invalid_option')
    }

    let data: string | null = null
    if (hasData) {
      // A string is text, ZPL almost always. Bytes go across as they are.
      data = (
        typeof input.data === 'string'
          ? Buffer.from(input.data, 'utf8')
          : Buffer.from(input.data as Uint8Array)
      ).toString('base64')
      const bytes = Buffer.byteLength(data, 'base64')
      if (bytes > MAX_INLINE_BYTES) {
        throw new AgentError(
          `Inline documents are limited to 50 MB; this one is ${Math.round(bytes / 1024 / 1024)} MB. Use \`url\` instead.`,
          agentId,
          'document_too_large'
        )
      }
    }

    let job = await this.store.createJob({
      agentId,
      kind: input.kind,
      format: input.format,
      printer: input.printer ?? null,
      options: compactPrintOptions(input.options),
      data,
      url: typeof input.url === 'string' ? input.url : null,
    })

    // A signed URL usually has to name the job, so resolve it once the job
    // exists and before anything is delivered.
    if (typeof input.url === 'function') {
      job = await this.store.updateJob(job.id, { url: await input.url(job.id) })
    }

    const sent = await this.deliver(job)
    if (!sent) this.log('info', 'print queued; agent offline', { agentId, jobId: job.id })
    return sent ? ((await this.store.findJob(job.id)) ?? job) : job
  }

  readonly jobs = {
    get: (id: string): Promise<JobRecord | null> => this.store.findJob(id),
    recent: (limit = 20): Promise<JobRecord[]> => this.store.recentJobs(limit),
    outstanding: (agentId: string): Promise<JobRecord[]> => this.store.unfinishedJobs(agentId),
  }

  private async deliver(job: JobRecord): Promise<boolean> {
    const message: ServerMessage = {
      type: 'print',
      id: job.id,
      kind: job.kind,
      format: job.format,
      // Omitted rather than null: a job that names no printer routes by
      // format, and an empty `options` says nothing.
      ...(job.printer ? { printer: job.printer } : {}),
      ...(job.options ? { options: job.options } : {}),
      ...(job.url ? { url: job.url } : { data: job.data ?? '' }),
    }

    // HTTP transport first. Its queue lives in the store, so any process can
    // write to it directly (TRANSPORTS.md §2.4). Publishing as well would
    // deliver twice.
    const session = await this.store.findLiveSessionByAgent(job.agentId, this.sessionWindowMs)
    if (session) {
      await this.store.enqueueSessionMessages(session.id, [message])
      this.httpSessions.get(session.id)?.wake()
      await this.markDelivered(job)
      return true
    }

    // WebSocket: publish unconditionally. Whichever process holds the socket
    // writes to it and marks the job sent (see the subscribe handler); every
    // other subscriber no-ops. The socket is usually held by a different
    // process from the one that created the job.
    await this.pubsub.publish(job.agentId, message)

    // Presence can be optimistic for up to its window. The job's status stays
    // honest either way: only a process that wrote to a live connection marks
    // it sent, and anything unacknowledged is redelivered at the next
    // handshake.
    return this.presence.isOnline(job.agentId)
  }

  private async markDelivered(job: JobRecord): Promise<void> {
    await this.store.updateJob(job.id, { status: 'sent', sentAt: Date.now() })
    this.emitter.emit('print', {
      agentId: job.agentId,
      jobId: job.id,
      kind: job.kind,
      format: job.format,
      printer: job.printer,
    })
  }

  /** A session polled within this window is live (matches the reaper). */
  private get sessionWindowMs(): number {
    return Math.max(this.config.pollSeconds * 2, 30) * 1000
  }

  /**
   * Presence writes, batched. Every inbound message is proof of life, but
   * presence is judged against a three-heartbeat window, so per-message writes
   * are waste, and at fleet scale the dominant store load. Ids buffer here and
   * flush once per heartbeat interval, on the touch that finds the flush due.
   * When traffic stops, flushing stops, which is what offline means. A `hello`
   * writes through immediately via `storeHello`.
   */
  private async touchAgent(agentId: string): Promise<void> {
    this.touched.add(agentId)
    const interval = this.config.heartbeatSeconds * 1000
    if (this.touchesFlushedAt !== 0 && Date.now() - this.touchesFlushedAt < interval) return
    this.touchesFlushedAt = Date.now()
    await this.flushTouches()
  }

  private async flushTouches(): Promise<void> {
    if (this.touched.size === 0) return
    const ids = [...this.touched]
    this.touched.clear()
    const at = Date.now()
    if (this.store.touchAgents) {
      await this.store.touchAgents(ids, at)
      return
    }
    for (const id of ids) {
      // Tolerate agents deleted since they were buffered.
      await this.store.updateAgent(id, { lastSeenAt: at }).catch(() => {})
    }
  }

  /**
   * The default presence: this process's connections, plus anything whose
   * `lastSeenAt` is within three heartbeats (PROTOCOL.md §6).
   */
  private storePresence(): Presence {
    const windowMs = () => this.config.heartbeatSeconds * 3 * 1000
    return {
      isOnline: async (agentId) => {
        if (this.registry.isOnline(agentId)) return true
        const agent = await this.store.findAgent(agentId)
        return agent?.lastSeenAt != null && agent.lastSeenAt > Date.now() - windowMs()
      },
      onlineIds: async () => {
        const cutoff = Date.now() - windowMs()
        const fresh = (await this.store.listAgents())
          .filter((agent) => agent.lastSeenAt != null && agent.lastSeenAt > cutoff)
          .map((agent) => agent.id)
        return [...new Set([...this.registry.onlineIds, ...fresh])]
      },
    }
  }

  // -- renewal --------------------------------------------------------------

  /**
   * Mint fresh credentials for anything expiring within `renewWithinDays`.
   * The new credential is stored, and the agent adopts it from its next
   * `ready` whether or not the push lands. A lapsed plan is logged and the
   * current credential stays in place.
   */
  async renew(): Promise<RenewalReport> {
    const due = await this.store.agentsNeedingRenewal(
      Date.now() + this.config.renewWithinDays * 24 * 60 * 60 * 1000
    )
    return this.remint(due)
  }

  /**
   * Mint fresh credentials for every paired agent, whatever the expiry.
   * Entitlements are read at mint time, so this is how a plan change reaches
   * the fleet; the webhook calls it. Concurrent calls coalesce to one run in
   * flight plus one queued behind it, because a webhook landing mid-run may
   * describe a change the run has already minted past for some agents.
   */
  refresh(): Promise<RenewalReport> {
    if (this.refreshRun) {
      this.refreshNext ??= this.refreshRun
        .catch(() => {})
        .then(() => {
          this.refreshNext = null
          return this.refresh()
        })
      return this.refreshNext
    }

    const run = (async () => {
      const paired = (await this.store.listAgents()).filter((agent) => agent.tokenDigest)
      return this.remint(paired)
    })().finally(() => {
      this.refreshRun = null
    })
    this.refreshRun = run
    return run
  }

  /**
   * Remove every local agent that bellhop.dev lists as deactivated: close its
   * connection and delete its record. `agents.remove` minus the deactivate
   * call, since the source already made the change. The `agent.deactivated`
   * webhook calls it.
   */
  async retireDeactivated(): Promise<{ retired: string[] }> {
    const { agents: remote } = await this.licensing.listAgents()
    const gone = new Set(
      remote.filter((entry) => entry.status === 'deactivated').map((entry) => entry.id)
    )

    const retired: string[] = []
    for (const agent of await this.store.listAgents()) {
      if (!gone.has(agent.remoteId)) continue
      this.registry.close(agent.id, 4003, 'This agent was removed.')
      await this.store.deleteAgent(agent.id)
      this.log('info', 'agent removed on bellhop.dev; retired here too', { agentId: agent.id })
      retired.push(agent.id)
    }
    return { retired }
  }

  private async remint(agents: AgentRecord[]): Promise<RenewalReport> {
    const renewed: string[] = []
    const failed: { agentId: string; code: string }[] = []

    for (const agent of agents) {
      try {
        const activation = await this.licensing.renew(agent.remoteId)
        await this.store.updateAgent(agent.id, {
          credential: activation.credential,
          credentialExpiresAt: Date.parse(activation.expires_at) || null,
        })
        // Best effort. The agent also adopts the new credential from its next
        // `ready`, and discards an invalid one.
        await this.pubsub.publish(agent.id, {
          type: 'credential',
          credential: activation.credential,
        })
        renewed.push(agent.id)
      } catch (error) {
        if (!(error instanceof LicensingError)) throw error
        failed.push({ agentId: agent.id, code: error.code })
        this.log('warn', 'renewal failed; keeping the current credential', {
          agentId: agent.id,
          code: error.code,
        })
      }
    }
    return { renewed, failed }
  }

  /**
   * `startRenewals()` unless `autoRenew: false`. Every transport calls this as
   * it attaches, since attaching one is how a process declares itself
   * long-lived.
   */
  autoStartRenewals(): void {
    if (this.config.autoRenew) this.startRenewals()
  }

  /**
   * Run `renew()` on an interval. Automatic when a transport is attached; call
   * it yourself only in a process that attaches none and has no job runner.
   */
  startRenewals(everyMs = 6 * 60 * 60 * 1000): void {
    if (this.renewalTimer) return
    const tick = () => {
      this.renew().catch((error: Error) => this.emitter.emit('error', error))
    }
    tick()
    this.renewalTimer = setInterval(tick, everyMs)
    this.renewalTimer.unref?.()
  }

  // -- session plumbing, shared by both transports ---------------------------

  /** The agent a bearer token belongs to, or null. */
  async authenticate(authorization: string | undefined): Promise<AgentRecord | null> {
    const token = bearerToken(authorization)
    if (!token) return null
    const presented = digest(token)
    const agent = await this.store.findAgentByTokenDigest(presented)
    // The lookup is an index hit. The constant-time compare costs nothing.
    return agent && secureEquals(agent.tokenDigest, presented) ? agent : null
  }

  /** Feed one inbound message from a connection into the protocol layer. */
  async receive(connection: Connection, message: AgentMessage): Promise<void> {
    this.lastInbound.set(connection, Date.now())
    // The record was authenticated when the connection opened and only changes
    // on `hello`, so it is cached per connection.
    let agent = this.agentCache.get(connection)
    if (!agent) {
      agent = (await this.store.findAgent(connection.agentId)) ?? undefined
      if (!agent) return
      this.agentCache.set(connection, agent)
    }
    try {
      await handleAgentMessage(this.sessionHost, agent, connection, message)
    } catch (error) {
      this.emitter.emit('error', error)
    }
    if (message?.type === 'hello') {
      const updated = await this.store.findAgent(connection.agentId)
      if (updated) this.agentCache.set(connection, updated)
    }
  }

  /** Called by a transport when a connection goes away. */
  releaseConnection(connection: Connection): void {
    this.registry.unregister(connection)
  }

  /** @internal Route a failure inside a transport to the `error` event. */
  reportError(error: Error): void {
    this.emitter.emit('error', error)
  }

  private buildSessionHost(): SessionHost {
    return {
      appName: this.config.appName,
      accentColor: this.config.accentColor,
      heartbeatSeconds: this.config.heartbeatSeconds,
      touch: (agentId) => this.touchAgent(agentId),
      storeHello: (agentId, hello: HelloMessage) =>
        this.store.updateAgent(agentId, {
          agentVersion: hello.agent_version ?? null,
          platform: hello.platform ?? null,
          capabilities: hello.capabilities ?? [],
          // A later `hello` replaces the last one, so the inventory is
          // overwritten rather than merged.
          printers: readPrinters(hello.printers),
          defaultPrinters: readDefaultPrinters(hello.default_printers),
          lastSeenAt: Date.now(),
        }),
      registerConnection: async (connection) => {
        this.registry.register(connection)
        if (!(connection instanceof HttpSession)) {
          // A socket handshake outdates any lingering HTTP session for this
          // agent. Leaving one live would route deliveries into a queue nobody
          // polls. Awaited so it lands before the handshake's flush.
          const session = await this.store.findLiveSessionByAgent(
            connection.agentId,
            this.sessionWindowMs
          )
          if (session) this.destroySession(session.id)
        }
      },
      flushOutstanding: async (agentId) => {
        const outstanding = await this.store.unfinishedJobs(agentId)
        if (outstanding.length === 0) return
        this.log('info', `redelivering ${outstanding.length} unacknowledged job(s)`, { agentId })
        // The agent keeps a ledger of the last 200 job ids per pairing and
        // answers a duplicate with the original ack (PROTOCOL.md §8).
        for (const job of outstanding) await this.deliver(job)
      },
      recordAck: async (agent, id, status, error, errorCode) => {
        const job = await this.store.findJob(id)
        if (!job || job.agentId !== agent.id) {
          this.log('info', 'ack for an unknown job, ignoring', { agentId: agent.id, jobId: id })
          return
        }
        // Idempotent: a redelivered job can be acked twice.
        await this.store.updateJob(id, { status, error, ackedAt: Date.now() })
        this.emitter.emit('ack', { agentId: agent.id, jobId: id, status, error, errorCode })
      },
      emit: (event, payload) => this.emitter.emit(event, payload),
      log: (level, message, context) => this.log(level, message, context),
    }
  }

  // -- HTTP surface: claim + the HTTP transport ------------------------------

  /**
   * Every route this library owns, as one function. The Express, Fastify, and
   * Web adapters are thin translations onto it; write your own in about thirty
   * lines.
   */
  async handleRequest(request: BellhopRequest): Promise<BellhopResponse> {
    const path = request.path.replace(/\/+$/, '') || '/'

    if (path === '/claim' && request.method === 'POST') return this.handleClaim(request)
    if (path === '/webhook' && request.method === 'POST') return this.handleWebhook(request)
    if (path.startsWith('/sessions')) return this.handleTransport(request, path)

    return { status: 404, body: { error: 'not_found' } }
  }

  private async handleClaim(request: BellhopRequest): Promise<BellhopResponse> {
    // Without a client address every caller would share one bucket and
    // pairing would fail fleet-wide, so the limiter steps aside and says so.
    if (request.ip === undefined) {
      this.warnOnce('claim rate limiting is off: this adapter supplied no client address')
    } else if (this.claimLimiter?.exceeded(request.ip)) {
      return fail(
        429,
        'too_many_requests',
        'Too many pairing attempts. Wait a minute and try again.'
      )
    }

    const presented = (request.body as { claim_token?: string } | undefined)?.claim_token
    if (!presented) {
      return fail(400, 'invalid_request', 'That pairing link is missing its claim token.')
    }

    // 1. Look up the claim token. Unknown, used, and expired are one answer,
    //    so a caller learns nothing from the difference.
    const claimDigest = digest(presented)
    const agent = await this.store.findAgentByClaimDigest(claimDigest)
    if (
      !agent ||
      !secureEquals(agent.claimTokenDigest, claimDigest) ||
      !agent.claimExpiresAt ||
      agent.claimExpiresAt < Date.now()
    ) {
      return fail(404, 'claim_expired', 'That pairing link has expired. Ask for a new one.')
    }

    // 2. Activate at bellhop.dev before consuming anything. A failure has to
    //    leave the claim token valid so the operator can retry the same link
    //    once the problem is fixed (PAIRING.md §3).
    let activation
    try {
      activation = await this.licensing.activate(agent.remoteId)
    } catch (error) {
      if (!(error instanceof LicensingError)) throw error
      this.log('warn', 'activation failed; the claim token stays valid', {
        agentId: agent.id,
        code: error.code,
      })
      return fail(502, error.code, error.operatorMessage)
    }

    // 3. Only now mint the agent token and consume the claim token.
    const agentToken = randomToken(32)
    const claimed = await this.store.updateAgent(agent.id, {
      tokenDigest: digest(agentToken),
      credential: activation.credential,
      credentialExpiresAt: Date.parse(activation.expires_at) || null,
      appName: activation.branding?.app_name ?? null,
      accentColor: activation.branding?.accent_color ?? null,
      claimTokenDigest: null,
      claimExpiresAt: null,
    })

    // Re-claiming rotates the token, so cut off the machine holding the old
    // one now rather than when it happens to reconnect (PAIRING.md §4).
    this.registry.close(agent.id, 4001, 'This agent was re-paired elsewhere.')

    this.log('info', 'agent claimed', {
      agentId: agent.id,
      expiresAt: activation.expires_at,
    })

    const body: ClaimResponse = {
      // Appears in this response and nowhere else.
      agent_token: agentToken,
      agent_name: claimed.label,
      app_name: claimed.appName ?? this.config.appName ?? 'Bellhop',
      accent_color: claimed.accentColor ?? this.config.accentColor ?? null,
      credential: activation.credential,
      transports: this.transports(),
    }
    return { status: 200, body }
  }

  /**
   * bellhop.dev's webhook (LICENSING.md, "Webhooks"). Register
   * `<publicUrl><basePath>/webhook` on your app's page on bellhop.dev; there is
   * nothing else to configure and no secret to hold.
   *
   * The event name is signed, so a verified delivery is safe to dispatch on.
   * `agent.deactivated` retires the removed agents here. Every other event,
   * including ones this library has never heard of, re-mints every paired
   * agent's credential, which keeps an old server correct when bellhop.dev
   * learns new reasons to call. The work runs behind the response.
   */
  private async handleWebhook(request: BellhopRequest): Promise<BellhopResponse> {
    const body = (request.body ?? {}) as { event?: unknown; app?: unknown }
    const claim = {
      event: typeof body.event === 'string' ? body.event : '',
      app: typeof body.app === 'string' ? body.app : '',
    }

    let verified: boolean
    try {
      verified = await this.webhooks.valid(request.getHeader('bellhop-signature'), claim)
    } catch (error) {
      if (!(error instanceof LicensingError)) throw error
      // The key set could not be fetched, so the signature could not be
      // judged. A 5xx makes bellhop.dev redeliver.
      return { status: 503, body: { error: 'keys_unavailable' } }
    }
    if (!verified) return { status: 401, body: { error: 'invalid_signature' } }

    if (claim.event === 'agent.deactivated') {
      this.log('info', `webhook received (${claim.event}); retiring removed agents`)
      void this.retireDeactivated().catch((error: Error) => this.emitter.emit('error', error))
    } else {
      this.log('info', `webhook received (${claim.event}); refreshing credentials`)
      void this.refresh().catch((error: Error) => this.emitter.emit('error', error))
    }
    return { status: 202, body: { ok: true } }
  }

  /**
   * Where to connect, most preferred first. An agent that receives none
   * assumes these defaults; spelling them out is the hook for moving the
   * socket to another host (TRANSPORTS.md §1).
   */
  transports(): TransportDescriptor[] {
    return [
      { type: 'websocket', url: this.config.socketUrl },
      { type: 'http', url: this.config.httpUrl },
    ]
  }

  private async handleTransport(request: BellhopRequest, path: string): Promise<BellhopResponse> {
    const agent = await this.authenticate(request.getHeader('authorization'))
    if (!agent) return { status: 401, body: { error: 'unauthorized' } }

    const segments = path.split('/').filter(Boolean) // ['sessions', id?, 'messages'?]

    // POST /sessions is the equivalent of connecting. The body is `hello`.
    if (segments.length === 1 && request.method === 'POST') {
      const hello = request.body as HelloMessage | undefined
      if (hello?.type !== 'hello') return { status: 400, body: { error: 'expected_hello' } }
      if (hello.protocol_version !== PROTOCOL_VERSION) {
        return { status: 426, body: { error: 'unsupported_version' } }
      }

      const id = `sess_${randomToken(12)}`
      const session = this.materializeSession(id, agent.id, false)
      await this.store.createSession(id, agent.id)

      // Synchronous replies (`ready`, here) ride the open response instead of
      // round-tripping the store. Prints flushed by the handshake go to the
      // store queue via deliver(), so they are not captured.
      const captured = session.capture()
      await this.receive(session, hello)
      const [ready, ...rest] = captured.stop()
      if (rest.length > 0) await this.store.enqueueSessionMessages(id, rest)

      return {
        status: 201,
        body: { session_id: id, poll_seconds: this.config.pollSeconds, message: ready },
      }
    }

    const sessionId = segments[1]
    const record = sessionId ? await this.store.findSession(sessionId) : null
    // A 404 means "open a new one". Cheap and normal. A local handle for a
    // session another process has already reaped goes with it.
    if (!sessionId || !record) {
      if (sessionId && this.httpSessions.has(sessionId)) this.destroySession(sessionId)
      return { status: 404, body: { error: 'no_such_session' } }
    }
    if (record.agentId !== agent.id) return { status: 404, body: { error: 'no_such_session' } }
    // The queue lives in the store, so this process not holding the session
    // object is normal: a non-sticky balancer, or a serverless instance that
    // did not open it. Materialize a local handle and carry on.
    const session =
      this.httpSessions.get(sessionId) ??
      this.materializeSession(sessionId, agent.id, record.handshakeComplete)
    session.lastRequestAt = Date.now()
    await this.store.touchSession(session.id)

    if (segments.length === 2 && request.method === 'DELETE') {
      this.destroySession(session.id)
      return { status: 200, body: {} }
    }

    if (segments[2] !== 'messages') return { status: 404, body: { error: 'not_found' } }

    // POST /sessions/:id/messages: agent to server, batched.
    if (request.method === 'POST') {
      const messages = (request.body as { messages?: AgentMessage[] } | undefined)?.messages ?? []
      const captured = session.capture()
      for (const message of messages) await this.receive(session, message)
      // Same shape as the poll response, so anything queued meanwhile rides
      // back here. Queued first, then the replies to this batch.
      const queued = await this.store.drainSessionMessages(session.id)
      return { status: 200, body: { messages: [...queued, ...captured.stop()] } }
    }

    // GET /sessions/:id/messages?wait=25: the long poll.
    if (request.method === 'GET') {
      const queued = await this.store.drainSessionMessages(session.id)
      if (queued.length > 0) return { status: 200, body: { messages: queued } }
      if (!session.open) return { status: 404, body: { error: 'session_closed' } }

      // `wait` is a hint and the server may always answer sooner
      // (TRANSPORTS.md §3.2), so it is capped at pollSeconds: an agent asking
      // for 25 on a server configured for 0 gets an immediate answer, and an
      // explicit 0 is honoured.
      const raw = request.query?.get('wait')
      const requested = raw == null || raw === '' ? this.config.pollSeconds : Number(raw)
      const wait = Math.min(
        Number.isFinite(requested) && requested >= 0 ? requested : this.config.pollSeconds,
        this.config.pollSeconds
      )
      if (wait <= 0) return { status: 200, body: { messages: [] } }

      // A held poll is woken by enqueues on this process. An enqueue from
      // another process is picked up on the next poll, so its worst case is
      // the wait window.
      return { status: 200, body: { messages: await session.wait(wait * 1000) } }
    }

    return { status: 405, body: { error: 'method_not_allowed' } }
  }

  private materializeSession(id: string, agentId: string, handshakeComplete: boolean): HttpSession {
    const session = new HttpSession(id, agentId, handshakeComplete, {
      enqueue: (sessionId, messages) => this.store.enqueueSessionMessages(sessionId, messages),
      drain: (sessionId) => this.store.drainSessionMessages(sessionId),
      setHandshakeComplete: (sessionId) =>
        this.store.updateSession(sessionId, { handshakeComplete: true }),
      destroy: (sessionId) => this.destroySession(sessionId),
      onError: (error) => this.emitter.emit('error', error),
    })
    this.httpSessions.set(id, session)
    return session
  }

  private destroySession(sessionId: string): void {
    const session = this.httpSessions.get(sessionId)
    this.httpSessions.delete(sessionId)
    if (session) {
      session.markClosed()
      this.registry.unregister(session)
    }
    if (this.storeClosed) return
    this.store.deleteSession(sessionId).catch((error: Error) => this.emitter.emit('error', error))
  }

  /**
   * Expiry is this transport's dropped socket. The agent's poll loop is
   * continuous, so a gap this long means it is gone.
   */
  private startSessionReaper(): void {
    this.reaper = setInterval(() => this.reap(), 5_000)
    this.reaper.unref?.()
  }

  private reap(): void {
    this.store
      .staleSessions(this.sessionWindowMs)
      .then((stale) => {
        for (const record of stale) this.destroySession(record.id)
      })
      .catch((error: Error) => this.emitter.emit('error', error))

    // Local handles for sessions another process already reaped.
    const staleLocal = Date.now() - this.sessionWindowMs
    for (const [id, session] of this.httpSessions) {
      if (session.lastRequestAt < staleLocal) this.destroySession(id)
    }

    // A socket that has gone quiet is half-open. The kernel can take hours to
    // notice, so drop it after three missed heartbeats (PROTOCOL.md §6). The
    // agent reconnects, and the handshake redelivers anything outstanding.
    const quiet = Date.now() - this.config.heartbeatSeconds * 3 * 1000
    for (const connection of this.registry.connections()) {
      if (!connection.terminate) continue
      const last = this.lastInbound.get(connection)
      if (last === undefined) this.lastInbound.set(connection, Date.now())
      else if (last < quiet) connection.terminate()
    }
  }

  // -- diagnostics ----------------------------------------------------------

  /** Everything that can be wrong with an environment before a message is exchanged. */
  doctor(): Promise<DoctorReport> {
    return runDoctor(this)
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Shut down, closing every agent connection with 1001. `retryAfterSeconds`
   * asks the fleet to spread its return over about that many seconds
   * (PROTOCOL.md §7.3). Worth setting on deploys once a synchronized reconnect
   * is itself a load event.
   */
  async close(options?: { retryAfterSeconds?: number }): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.reaper) clearInterval(this.reaper)
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    this.registry.closeAll(1001, 'Server shutting down.', options?.retryAfterSeconds)
    for (const id of [...this.httpSessions.keys()]) this.destroySession(id)
    // Buffered presence writes land before the store goes away.
    await this.flushTouches().catch(() => {})
    await this.pubsub.close?.()
    await this.presence.close?.()
    this.storeClosed = true
    await this.store.close?.()
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.log('warn', message)
  }

  private log(level: 'info' | 'warn' | 'error', message: string, context?: unknown): void {
    this.logger?.[level]?.(
      `[bellhop] ${message}`,
      context === undefined ? undefined : redact(context)
    )
  }
}

const fail = (status: number, code: string, message: string): BellhopResponse => ({
  status,
  // The agent shows `message` to whoever is standing at the printer
  // (PAIRING.md §2).
  body: { error: { code, message } },
})
