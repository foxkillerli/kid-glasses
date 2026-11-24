import { describe, expect, it } from 'vitest'
import { echoUrlFor, PUBLIC_ECHO_URL } from '../src/app'

describe('echoUrlFor', () => {
  it('uses the same-origin worker echo when hosted over https', () => {
    expect(echoUrlFor({ protocol: 'https:', host: 'kid-glasses-m0.your-subdomain.workers.dev', hostname: 'kid-glasses-m0.your-subdomain.workers.dev' })).toBe(
      'wss://kid-glasses-m0.your-subdomain.workers.dev/echo',
    )
  })
  it('falls back to the public echo for local dev', () => {
    expect(echoUrlFor({ protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' })).toBe(PUBLIC_ECHO_URL)
    expect(echoUrlFor({ protocol: 'https:', host: 'localhost:5173', hostname: 'localhost' })).toBe(PUBLIC_ECHO_URL)
  })
})
