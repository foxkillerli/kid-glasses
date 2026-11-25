import { describe, expect, it, vi } from 'vitest'
import { AUTH_ALARM_SLACK_MS, AUTH_TIMEOUT_FRAME, CLOSE_AUTH_TIMEOUT, AUTH_TIMEOUT_MS, checkDeviceToken, deviceTokenConfigured, offeredDeviceProtocol, sweepUnauthed } from '../src/device-auth'

const TOKEN = 'a'.repeat(40)

describe('device token', () => {
  it('accepts only the configured token', () => {
    expect(checkDeviceToken(TOKEN, TOKEN)).toBe('ok')
    expect(checkDeviceToken('nope', TOKEN)).toBe('bad')
    expect(checkDeviceToken(undefined, TOKEN)).toBe('bad')
    expect(checkDeviceToken(42, TOKEN)).toBe('bad')
    expect(checkDeviceToken('x'.repeat(300), TOKEN)).toBe('bad')
  })

  it('fails closed when DEVICE_TOKEN is unset or shorter than 32 chars', () => {
    expect(checkDeviceToken('short', 'short')).toBe('not-configured')
    expect(checkDeviceToken(TOKEN, undefined)).toBe('not-configured')
    expect(deviceTokenConfigured(TOKEN)).toBe(true)
    expect(deviceTokenConfigured('')).toBe(false)
  })

  it('only negotiates the public kg.v1 subprotocol; no token travels in the handshake', () => {
    expect(offeredDeviceProtocol(new Headers({ 'Sec-WebSocket-Protocol': 'foo, kg.v1' }))).toBe('kg.v1')
    expect(offeredDeviceProtocol(new Headers({ 'Sec-WebSocket-Protocol': 'foo' }))).toBeNull()
    expect(offeredDeviceProtocol(new Headers())).toBeNull()
  })
})

describe('M3-2 unauthenticated socket sweep', () => {
  const sock = (a: unknown, readyState = 1) => ({ send: vi.fn(), deserializeAttachment: () => a, readyState })

  it('expires sockets at exactly 10 s after connect and schedules the next alarm 100 ms after the earliest remaining deadline', () => {
    const late = sock({ authed: false, connectedAt: 0 })
    const fresh = sock({ authed: false, connectedAt: 4_000 })
    const fresher = sock({ authed: false, connectedAt: 7_000 })
    const authed = sock({ authed: true, connectedAt: 0 })
    expect(sweepUnauthed([late, fresh, fresher, authed], 9_999)).toEqual({ expired: [], nextAlarmAt: AUTH_TIMEOUT_MS + AUTH_ALARM_SLACK_MS })
    const r = sweepUnauthed([late, fresh, fresher, authed], AUTH_TIMEOUT_MS)
    expect(r.expired).toEqual([late])
    expect(r.nextAlarmAt).toBe(4_000 + AUTH_TIMEOUT_MS + AUTH_ALARM_SLACK_MS)
    expect(sweepUnauthed([authed], 1e9)).toEqual({ expired: [], nextAlarmAt: null })
  })

  it('skips sockets that are already closing, expires ones with no attachment, and reports unreadable ones', () => {
    const closing = sock({ authed: false, connectedAt: 0 }, 2)
    const bare = sock(null)
    const broken = { send: vi.fn(), deserializeAttachment: () => { throw new Error('gone') }, readyState: 1 }
    const skipped: unknown[] = []
    expect(sweepUnauthed([closing, bare, broken], 50_000, e => skipped.push(e))).toEqual({ expired: [bare], nextAlarmAt: null })
    expect(skipped).toHaveLength(1)
  })

  it('the timeout notice is an error frame with no secrets in it', () => {
    expect(JSON.parse(AUTH_TIMEOUT_FRAME)).toMatchObject({ t: 'error', code: 'auth-timeout' })
    expect(CLOSE_AUTH_TIMEOUT).toBe(4408)
  })
})
