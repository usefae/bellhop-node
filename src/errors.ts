/** Errors this library throws, and the one it raises for bellhop.dev's answers. */

export type ConfigurationErrorCode =
  'missing_secret_key' | 'missing_public_url' | 'invalid_public_url' | 'unsupported_node'

export type AgentErrorCode =
  | 'agent_not_found'
  | 'invalid_input'
  | 'unknown_printer'
  | 'unsupported_format'
  | 'invalid_option'
  | 'document_too_large'

/** Every error this library throws carries a `code` a program can branch on. */
export class BellhopError extends Error {
  override readonly name: string = 'BellhopError'
  readonly code: string

  constructor(message: string, options: { code: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = options.code
  }
}

/** Configuration that cannot work. Raised at construction. */
export class ConfigurationError extends BellhopError {
  override readonly name = 'ConfigurationError'
  declare readonly code: ConfigurationErrorCode

  constructor(message: string, code: ConfigurationErrorCode, cause?: unknown) {
    super(message, { code, cause })
  }
}

/** `print()` refused a job before it existed. `code` says why. */
export class AgentError extends BellhopError {
  override readonly name = 'AgentError'
  declare readonly code: AgentErrorCode

  constructor(
    message: string,
    readonly agentId: string,
    code: AgentErrorCode
  ) {
    super(message, { code })
  }
}

/**
 * A non-2xx from the bellhop.dev licensing API, or an unreachable one. `code`
 * is bellhop.dev's error code, or `unreachable`.
 *
 * `retryable` matters for pairing: PAIRING.md §3 says a failed activation must
 * leave the claim token unconsumed so the operator can try the same link
 * again.
 */
export class LicensingError extends BellhopError {
  override readonly name = 'LicensingError'
  readonly status: number
  readonly body: unknown

  constructor(input: {
    code?: string
    message?: string
    status: number
    body?: unknown
    cause?: unknown
  }) {
    super(input.message || input.code || `bellhop.dev returned ${input.status}`, {
      code: input.code || 'unknown_error',
      cause: input.cause,
    })
    this.status = input.status
    this.body = input.body
  }

  /** Unreachable, not in good standing, or a server fault. Worth another attempt. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 402 || this.status >= 500
  }

  /** For whoever is standing at the printer. The agent shows it verbatim during a failed claim. */
  get operatorMessage(): string {
    switch (this.code) {
      case 'payment_required':
        return 'This app’s Bellhop plan needs attention. Ask an administrator, then try this link again.'
      case 'agent_deactivated':
        return 'This agent was removed. Ask for a new pairing link.'
      case 'agent_limit_reached':
        return 'This app has no agent slots left. Ask an administrator, then try this link again.'
      case 'unreachable':
        return 'Could not reach the licensing service. Check the connection and try this link again.'
      default:
        return 'Could not license this agent right now. Try this link again in a moment.'
    }
  }
}
