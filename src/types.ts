/**
 * The Bellhop agent protocol, version 1.
 *
 * Written by hand rather than generated so the types can carry documentation.
 * `test/schema.test.ts` checks representative messages against
 * `docs/schemas/v1/*.json`, so they cannot drift from the schemas.
 *
 * Both sides ignore what they do not recognise (PROTOCOL.md §1, rule 4). That
 * is the protocol's only forward-compatibility mechanism, so nothing here
 * validates inbound messages strictly and every inbound type allows unknown
 * fields.
 */

export const PROTOCOL_VERSION = 1

/** Unknown fields are allowed on every inbound message and must be ignored. */
export type Unknown = Record<string, unknown>

// ---------------------------------------------------------------------------
// Agent to server
// ---------------------------------------------------------------------------

/**
 * The first message of every session, sent again whenever the agent's
 * advertised state changes: a different printer, the scale shared, a new
 * credential. A later `hello` replaces the previous one; it is never a patch.
 */
export interface HelloMessage extends Unknown {
  type: 'hello'
  protocol_version: number
  /** Build version of the agent, for admin screens and support. */
  agent_version: string
  platform: 'macos' | 'windows' | 'linux' | (string & {})
  /** Fresh per session. Distinguishes a reconnect from a duplicate connection. */
  session_id: string
  /**
   * What this agent may be asked to do right now. A server must not send a
   * `print` whose `format` has no matching `print:<format>` capability;
   * {@link Bellhop.print} enforces it.
   */
  capabilities: Capability[]
  /**
   * The printers the operator has shared with this pairing, and nothing else.
   * A printer nobody shared is not here, and its absence cannot be detected.
   */
  printers?: Printer[]
  /**
   * Role to printer `id`: where a job that names no `printer` goes. Roles in
   * version 1 are `label` (zpl, raw, gif) and `document` (pdf). A job that
   * routes to a missing role fails rather than landing on an arbitrary queue.
   */
  default_printers?: Record<string, string>
}

/** One printer the operator has shared. A `print` names its `id` to target it. */
export interface Printer extends Unknown {
  /**
   * Stable for as long as the queue exists on that machine, and opaque. Do not
   * parse it, and do not assume the same physical printer has the same id on
   * another machine. On macOS and Linux it is the CUPS queue name.
   */
  id: string
  /** For admin screens only. Display names are not unique. */
  name: string
  capabilities: PrinterCapabilities
}

/**
 * What one printer can be asked to do. Each field answers one print option.
 *
 * Present means known. A field is present when the agent read its value and
 * absent when it could not. A driver with no duplex feature reports
 * `duplex: false`; a queue with no choice of tray reports `bins: []`; a queue
 * whose driver could not be read at all reports `{}`. An option the agent
 * cannot check fails the job rather than being guessed at.
 */
export interface PrinterCapabilities extends Unknown {
  /** Media keywords as the driver reports them. Answers `options.paper`. */
  papers?: string[]
  /** Which of `papers` the queue uses when a job does not say. */
  default_paper?: string
  /** Input tray keywords as the driver reports them. Answers `options.bin`. */
  bins?: string[]
  default_bin?: string
  /** Resolutions in dots per inch. Answers `options.dpi`. */
  dpi?: number[]
  default_dpi?: number
  duplex?: boolean
  color?: boolean
}

export type Capability =
  'print:zpl' | 'print:raw' | 'print:pdf' | 'print:gif' | 'scale' | (string & {})

/**
 * The document format of a print job. `zpl` and `raw` are both delivered to
 * the queue untouched; `raw` is for ESC/POS, EPL, and anything else the
 * hardware speaks. `pdf` and `gif` are rendered by the system print system.
 */
export type PrintFormat = 'zpl' | 'raw' | 'pdf' | 'gif'

/**
 * How to print a job. Every option is optional; an absent one means whatever
 * the target printer does by default.
 *
 * This is the one place in the protocol where an unrecognised key is an error.
 * Dropping `{ duplx: ... }` quietly would print the wrong thing and report
 * success. {@link Bellhop.print} refuses what is knowable without an agent: an
 * unknown name, a value outside its range, a malformed page range, an option
 * that does not apply to the format. Anything about the particular printer is
 * checked by the agent, and fails the job there.
 */
export interface PrintOptions {
  /** 1 to 100. For `zpl` and `raw` the agent delivers the byte stream this many times. */
  copies?: number
  /** `pdf` only. Which sides, and which edge the sheet flips on. */
  duplex?: 'one-sided' | 'long-edge' | 'short-edge'
  /** `pdf` and `gif`. One of the target's `capabilities.papers`, byte for byte. */
  paper?: string
  /** `pdf` and `gif`. One of the target's `capabilities.bins`. */
  bin?: string
  /** `pdf` and `gif`. One of the target's `capabilities.dpi`. */
  dpi?: number
  /** `pdf` and `gif`. `true` needs `capabilities.color` on the target. */
  color?: boolean
  /** `pdf` only. One-based, ascending, non-overlapping, no spaces: `"1-4,7,9-12"`. */
  pages?: string
  /** `pdf` and `gif`. Degrees clockwise. */
  rotate?: 0 | 90 | 180 | 270
  /** `pdf` and `gif`. Scale to the media. Defaults to true; false clips. */
  fit?: boolean
  /** `pdf` only. With more than one copy, `1,2,3,1,2,3` rather than `1,1,2,2,3,3`. */
  collate?: boolean
  /** `pdf` only. Pages per sheet. */
  nup?: 1 | 2 | 4 | 6 | 9 | 16
}

/**
 * The response to a `print`. Every print is acknowledged exactly once.
 *
 * `printed` means the document was handed to the system print system without
 * error. Paper may still not have come out: printers jam and run out of
 * labels. Present it to your users that way.
 */
export interface AckMessage extends Unknown {
  type: 'ack'
  id: string
  status: 'printed' | 'failed'
  /** The sentence a person reads. Set on every failure. */
  error?: string | null
  /**
   * The failure class a program branches on. The registry is open: treat a
   * code you do not recognise as a plain failure.
   */
  error_code?: AckErrorCode | null
}

/** PROTOCOL.md §4.2. Open: an unrecognised code is a plain failure. */
export type AckErrorCode =
  | 'unknown_printer'
  | 'no_default_printer'
  | 'unsupported_format'
  | 'unsupported_option'
  | 'invalid_option'
  | 'unsupported_value'
  | 'document_unavailable'
  | 'printer_error'
  | (string & {})

/**
 * A stable scale reading. The agent has already filtered it: stable, non-zero,
 * repeated twice before sending, never re-sent unchanged. Do not debounce it
 * again.
 */
export interface WeightMessage extends Unknown {
  type: 'weight'
  grams: number
  /** Always true in version 1. Reserved for streaming unstable readings. */
  stable: boolean
}

/** Informational agent state. Nothing in the protocol depends on these. */
export interface EventMessage extends Unknown {
  type: 'event'
  code: 'scale_attached' | 'scale_detached' | (string & {})
  message?: string
  /** RFC 3339, UTC. */
  at?: string
}

export interface PingMessage extends Unknown {
  type: 'ping'
  token?: string
}

export interface PongMessage extends Unknown {
  type: 'pong'
  token?: string
}

export type AgentMessage =
  HelloMessage | AckMessage | WeightMessage | EventMessage | PingMessage | PongMessage

// ---------------------------------------------------------------------------
// Server to agent
// ---------------------------------------------------------------------------

/**
 * The response to `hello`, and the only message a server may send before it.
 * `credential` is included on every `ready` so a renewed credential reaches
 * the agent on its next reconnect with nobody visiting the machine.
 */
export interface ReadyMessage {
  type: 'ready'
  protocol_version: number
  app_name?: string
  /** `#RRGGBB`. */
  accent_color?: string | null
  credential?: string | null
  /** The agent clamps this to between 5 and 120. */
  heartbeat_seconds?: number
}

/**
 * Print a document. Exactly one of `data` and `url` is present.
 *
 * `kind` is yours and opaque to the agent. It appears in the agent's recent
 * activity list and nowhere else. `printer` decides where the document goes,
 * and failing that, the role `format` routes to in `default_printers`.
 */
export interface PrintMessage {
  type: 'print'
  /** Opaque, unique per pairing, never reused. The agent deduplicates on it. */
  id: string
  kind: string
  format: PrintFormat
  /** The `id` of a printer from the agent's most recent `hello`. Overrides routing. */
  printer?: string
  options?: PrintOptions
  /** Base64 of the document bytes. At most 50 MB decoded. */
  data?: string
  /** HTTPS, or http on loopback. Must carry its own authorisation. */
  url?: string
}

/** A mid-session branding update. `ready` covers the normal case. */
export interface ConfigMessage {
  type: 'config'
  app_name?: string
  accent_color?: string | null
}

/** A mid-session licence update, for when a reconnect is too long to wait. */
export interface CredentialMessage {
  type: 'credential'
  credential: string
}

/**
 * Sent immediately before the transport closes, carrying the reason the
 * transport's own close mechanism would carry. Not every framework lets you
 * choose a WebSocket close code, and the HTTP transport has no close frame.
 */
export interface CloseMessage {
  type: 'close'
  code: CloseCode
  reason: string
  /**
   * Pacing hint for the reconnect after a retryable close, applied by the
   * agent to its next attempt only (PROTOCOL.md §7.3). 1 to 600 seconds. A
   * WebSocket close frame has no room for it, so it travels here.
   */
  retry_after_seconds?: number
}

export type ServerMessage =
  | ReadyMessage
  | PrintMessage
  | ConfigMessage
  | CredentialMessage
  | CloseMessage
  | PingMessage
  | PongMessage

// ---------------------------------------------------------------------------
// Ending a session
// ---------------------------------------------------------------------------

/**
 * Terminal codes stop the agent until a human intervenes. Nothing else in the
 * protocol is terminal: an agent must survive an arbitrarily long outage.
 */
export const CloseCodes = {
  /** Terminal. Token unknown, rotated, or revoked. Shows "re-pair this agent". */
  unauthorized: 4001,
  /** Terminal. The server does not speak the agent's protocol version. */
  unsupportedVersion: 4002,
  /** Terminal. The agent record was removed or deactivated. */
  agentDeactivated: 4003,
  /** Retryable. Another session took over this agent. */
  superseded: 4004,
  /** Retryable. Switch to the next advertised transport. */
  tryOtherTransport: 4005,
} as const

export type CloseCode = (typeof CloseCodes)[keyof typeof CloseCodes] | (number & {})

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** The body of a successful `POST /bellhop/claim`. */
export interface ClaimResponse {
  /** Appears here and nowhere else. */
  agent_token: string
  agent_name?: string
  app_name: string
  accent_color?: string | null
  credential: string
  transports?: TransportDescriptor[]
}

export interface TransportDescriptor {
  type: 'websocket' | 'http'
  url: string
}

/** The agent shows `message` to the operator verbatim. Write it for a person. */
export interface ClaimErrorResponse {
  error: { code: string; message: string }
}
