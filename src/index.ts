/**
 * Bellhop for Node. Print to the label printers and read the USB scales at a
 * physical location, over a connection you own.
 *
 *   import { Bellhop } from '@usefae/bellhop-node'
 *   import { bellhopExpress } from '@usefae/bellhop-node/express'
 *   import { attachWebSocket } from '@usefae/bellhop-node/ws'
 *   import { sqliteStore } from '@usefae/bellhop-node/sqlite'
 *
 *   const bellhop = new Bellhop({
 *     secretKey: process.env.BELLHOP_SECRET_KEY!,
 *     publicUrl: 'https://deliver.example.com',
 *     store: sqliteStore('bellhop.db'),
 *   })
 *
 *   app.use(bellhopExpress(bellhop))
 *   attachWebSocket(bellhop, server)
 */

export { Bellhop } from './bellhop.js'
export type {
  BellhopEvents,
  BellhopRequest,
  BellhopResponse,
  CreateAgentResult,
  PrintInput,
  RenewalReport,
} from './bellhop.js'
export type { DoctorCheck, DoctorReport } from './doctor.js'

export { WebhookVerifier, parseSignatureHeader } from './webhooks.js'
export type { SignatureFields } from './webhooks.js'

export type { BellhopOptions, Logger, ResolvedConfig } from './config.js'
export { BellhopError, ConfigurationError, LicensingError, AgentError } from './errors.js'
export type { AgentErrorCode, ConfigurationErrorCode } from './errors.js'
export { inProcessPubSub } from './connections.js'
export type { Connection, Presence, PubSub } from './connections.js'
export { memoryStore } from './store/memory.js'
export type {
  JobPatch,
  JobRecord,
  JobStatus,
  SessionRecord,
  AgentPatch,
  AgentRecord,
  Store,
} from './store/types.js'
export { LicensingClient } from './licensing.js'
export type {
  Activation,
  AppSummary,
  Branding,
  LicensingClientOptions,
  RemoteAgent,
  SigningKey,
} from './licensing.js'

export { CloseCodes, PROTOCOL_VERSION } from './types.js'
export type {
  AckErrorCode,
  AckMessage,
  AgentMessage,
  Capability,
  ClaimErrorResponse,
  ClaimResponse,
  CloseCode,
  CloseMessage,
  ConfigMessage,
  CredentialMessage,
  EventMessage,
  HelloMessage,
  PingMessage,
  PongMessage,
  Printer,
  PrinterCapabilities,
  PrintFormat,
  PrintMessage,
  PrintOptions,
  ReadyMessage,
  ServerMessage,
  TransportDescriptor,
  WeightMessage,
} from './types.js'
