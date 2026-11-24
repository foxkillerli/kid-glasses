import { timingSafeEqual } from './slack-verify'

export const DEVICE_PROTOCOL = 'kg.v1'
const TOKEN_PROTOCOL_PREFIX = 'kg-token.'
export const MIN_DEVICE_TOKEN_LENGTH = 32

export type DeviceAuth = { ok: true; protocol: string | null } | { ok: false; status: 401 | 503; reason: string }

export function authenticateDevice(headers: Headers, deviceToken: string | undefined): DeviceAuth {
  if (!deviceToken || deviceToken.length < MIN_DEVICE_TOKEN_LENGTH) return { ok: false, status: 503, reason: 'device-token-not-configured' }
  const offered = (headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const fromProtocol = offered.find(p => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length)
  const auth = headers.get('Authorization') ?? ''
  const fromBearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined
  const presented = fromProtocol ?? fromBearer
  if (!presented || !timingSafeEqual(presented, deviceToken)) return { ok: false, status: 401, reason: 'bad-device-token' }
  return { ok: true, protocol: offered.includes(DEVICE_PROTOCOL) ? DEVICE_PROTOCOL : null }
}
