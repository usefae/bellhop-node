import { describe, expect, it } from 'vitest'
import { Bellhop } from '../src/bellhop.js'
import { resolveConfig } from '../src/config.js'
import { ConfigurationError } from '../src/errors.js'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as ConfigurationError).code
  }
  throw new Error('did not throw')
}

describe('configuration', () => {
  it('refuses what cannot work, with a code for each reason', () => {
    expect(codeOf(() => resolveConfig({ secretKey: '', publicUrl: 'http://localhost' }))).toBe(
      'missing_secret_key'
    )
    expect(codeOf(() => resolveConfig({ secretKey: 'k', publicUrl: '' }))).toBe(
      'missing_public_url'
    )
    expect(codeOf(() => resolveConfig({ secretKey: 'k', publicUrl: 'deliver.example.com' }))).toBe(
      'invalid_public_url'
    )
    expect(
      codeOf(() => resolveConfig({ secretKey: 'k', publicUrl: 'ftp://deliver.example.com' }))
    ).toBe('invalid_public_url')
    expect(
      codeOf(() => resolveConfig({ secretKey: 'k', publicUrl: 'http://deliver.example.com' }))
    ).toBe('invalid_public_url')
    expect(() => new Bellhop({ secretKey: '', publicUrl: 'x' })).toThrow(ConfigurationError)
  })

  it('derives the pairing host and both transport urls', () => {
    const config = resolveConfig({
      secretKey: 'k',
      publicUrl: 'https://deliver.example.com:8443/',
      basePath: 'print/',
    })
    expect(config.serverHost).toBe('deliver.example.com:8443')
    expect(config.socketUrl).toBe('wss://deliver.example.com:8443/print/socket')
    expect(config.httpUrl).toBe('https://deliver.example.com:8443/print')

    // A default port is dropped, the way the agent derives its own key.
    expect(
      resolveConfig({ secretKey: 'k', publicUrl: 'https://deliver.example.com:443' }).serverHost
    ).toBe('deliver.example.com')
  })

  it('mounts at the root when basePath is "/"', () => {
    const config = resolveConfig({
      secretKey: 'k',
      publicUrl: 'http://localhost:3000',
      basePath: '/',
    })
    expect(config.basePath).toBe('')
    expect(config.httpUrl).toBe('http://localhost:3000')
    expect(config.socketUrl).toBe('ws://localhost:3000/socket')
  })

  it('fills the documented defaults', () => {
    const config = resolveConfig({ secretKey: 'k', publicUrl: 'http://localhost:3000' })
    expect(config).toMatchObject({
      apiUrl: 'https://bellhop.dev',
      basePath: '/bellhop',
      heartbeatSeconds: 20,
      pollSeconds: 25,
      autoRenew: true,
      claimRateLimit: { max: 10, windowMs: 60_000 },
    })
    expect(
      resolveConfig({ secretKey: 'k', publicUrl: 'http://localhost', apiUrl: 'https://x/' }).apiUrl
    ).toBe('https://x')
  })
})
