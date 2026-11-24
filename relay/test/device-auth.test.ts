import { describe, expect, it } from 'vitest'
import { checkDeviceToken, deviceTokenConfigured, offeredDeviceProtocol } from '../src/device-auth'

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
