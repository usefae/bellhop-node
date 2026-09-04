/**
 * Everything that can be wrong with an environment before a message is
 * exchanged. `bellhop.doctor()` and `bellhop doctor` both come here.
 */

import type { Bellhop } from './bellhop.js'
import type { LicensingError } from './errors.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
  remedy?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

export async function runDoctor(bellhop: Bellhop): Promise<DoctorReport> {
  const { config, licensing, store } = bellhop
  const checks: DoctorCheck[] = []
  const add = (name: string, ok: boolean, detail: string, remedy?: string): void => {
    checks.push({ name, ok, detail, ...(remedy ? { remedy } : {}) })
  }

  add(
    'publicUrl',
    true,
    `pairing host is ${config.serverHost}`,
    'Every credential is bound to this host and the agent compares it byte for byte. Changing it means every agent re-pairs.'
  )

  let app
  try {
    app = await licensing.app()
    add('secret key', true, `authenticated as "${app.name}"`)
    add(
      'plan',
      app.in_good_standing,
      `${app.plan}, ${app.active_agent_count}/${app.entitlements.agent_cap} agents`,
      app.in_good_standing ? undefined : 'Activation and renewal will fail with payment_required.'
    )
    add(
      'scales',
      true,
      app.entitlements.scales_allowed
        ? 'allowed on this plan'
        : 'not on this plan: agents will not advertise `scale` or send weights',
      app.entitlements.scales_allowed
        ? undefined
        : 'The plan decides this. Operators toggling the scale on will still see nothing.'
    )
    add(
      'printers',
      true,
      app.entitlements.max_printers === null
        ? 'unlimited'
        : `${app.entitlements.max_printers}: every format routes to the one configured queue`
    )
    add(
      'webhook',
      true,
      app.webhook_registered ? 'registered' : 'not registered',
      app.webhook_registered
        ? undefined
        : `Optional: without one, plan changes wait for the next renewal. Register ${config.httpUrl}/webhook on your app's page on bellhop.dev and they land in moments.`
    )
  } catch (error) {
    const failure = error as LicensingError
    const tls = /certificate|self.signed|UNABLE_TO_VERIFY/i.test(failure.message)
    add(
      'secret key',
      false,
      `${config.apiUrl} said ${failure.code} (HTTP ${failure.status})`,
      tls
        ? 'This host serves a certificate Node does not trust. Node ignores the OS trust store by default, so a self-hosted licensing endpoint needs --use-system-ca (or NODE_EXTRA_CA_CERTS).'
        : 'Check BELLHOP_SECRET_KEY and apiUrl.'
    )
  }

  try {
    const { keys } = await licensing.signingKeys()
    const kids = keys.map((key) => key.kid)
    add(
      'signing keys',
      keys.length > 0,
      `${config.apiUrl} publishes ${kids.join(', ') || 'nothing'}`,
      'The agent verifies credentials offline against keys baked into its build. If its key set does not include these, every credential fails with "signed with an unknown key": rebuild it with `make keys KEYS_URL=' +
        config.apiUrl +
        '/.well-known/bellhop-keys.json`.'
    )
  } catch {
    add('signing keys', false, `could not read ${config.apiUrl}/.well-known/bellhop-keys.json`)
  }

  const agents = await store.listAgents()
  const unpaired = agents.filter((s) => !s.tokenDigest).length
  add(
    'agents',
    true,
    `${agents.length} known, ${(await bellhop.agents.onlineIds()).length} online, ${unpaired} never paired`
  )

  const expiring = await store.agentsNeedingRenewal(
    Date.now() + config.renewWithinDays * 24 * 60 * 60 * 1000
  )
  add(
    'credentials',
    expiring.length === 0,
    expiring.length === 0
      ? 'none expiring soon'
      : `${expiring.length} expiring within ${config.renewWithinDays} days`,
    expiring.length === 0
      ? undefined
      : 'Renewal is automatic once a transport is attached; call bellhop.renew() to do it now.'
  )

  return { ok: checks.every((check) => check.ok), checks }
}
