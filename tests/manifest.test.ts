import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Even Hub manifest (app.json)', () => {
  const manifest = JSON.parse(readFileSync('app.json', 'utf8')) as {
    package_id: string
    edition: string
    name: string
    version: string
    min_sdk_version: string
    entrypoint: string
    permissions: Array<{ name: string; desc: string; whitelist?: string[] }>
    supported_languages: string[]
  }

  it('uses Grok Connector as the display name within Even Hub limits', () => {
    expect(manifest.name).toBe('Grok Connector')
    expect(manifest.name.length).toBeLessThanOrEqual(20)
    expect(manifest.name.toLowerCase()).not.toContain('even')
  })

  it('keeps a valid reverse-domain package_id, edition, semver, and entrypoint', () => {
    expect(manifest.package_id).toBe('com.foxkiller.kidglasses')
    expect(manifest.package_id).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/)
    expect(manifest.edition).toBe('202601')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.min_sdk_version).toBe('0.0.16')
    expect(manifest.entrypoint).toBe('index.html')
  })

  it('whitelists the relay and plugin worker origins under network permission', () => {
    const net = manifest.permissions.find(p => p.name === 'network')
    expect(net).toBeDefined()
    expect(net?.whitelist).toEqual(
      expect.arrayContaining([
        'https://kid-glasses-relay.your-subdomain.workers.dev',
        'wss://kid-glasses-relay.your-subdomain.workers.dev',
      ]),
    )
    expect(manifest.supported_languages).toEqual(['en', 'zh'])
  })
})
