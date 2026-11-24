import { describe, expect, it } from 'vitest'
import { authenticateDevice } from '../src/device-auth'

const TOKEN = 'a'.repeat(40)

describe('authenticateDevice', () => {
  it('accepts the token offered as a WebSocket subprotocol and echoes kg.v1', () => {
    const h = new Headers({ 'Sec-WebSocket-Protocol': `kg.v1, kg-token.${TOKEN}` })
    expect(authenticateDevice(h, TOKEN)).toEqual({ ok: true, protocol: 'kg.v1' })
  })

  it('accepts a bearer token for non-browser clients', () => {
    expect(authenticateDevice(new Headers({ Authorization: `Bearer ${TOKEN}` }), TOKEN)).toEqual({ ok: true, protocol: null })
  })

  it('rejects a wrong or missing token with 401', () => {
    expect(authenticateDevice(new Headers({ 'Sec-WebSocket-Protocol': 'kg.v1, kg-token.nope' }), TOKEN)).toMatchObject({ ok: false, status: 401 })
    expect(authenticateDevice(new Headers(), TOKEN)).toMatchObject({ ok: false, status: 401 })
  })

  it('fails closed with 503 when DEVICE_TOKEN is unset or too short', () => {
    expect(authenticateDevice(new Headers({ Authorization: 'Bearer ' }), undefined)).toMatchObject({ ok: false, status: 503 })
    expect(authenticateDevice(new Headers({ Authorization: 'Bearer short' }), 'short')).toMatchObject({ ok: false, status: 503 })
  })
})
