import { timingSafeEqual } from './slack-verify'

export const DEVICE_PROTOCOL = 'kg.v1'
export const MIN_DEVICE_TOKEN_LENGTH = 32
export const AUTH_TIMEOUT_MS = 10_000
export const MAX_TOKEN_LENGTH = 256

export function deviceTokenConfigured(token: string | undefined): token is string {
  return !!token && token.length >= MIN_DEVICE_TOKEN_LENGTH
}

export type TokenCheck = 'ok' | 'not-configured' | 'bad'

export function checkDeviceToken(presented: unknown, configured: string | undefined): TokenCheck {
  if (!deviceTokenConfigured(configured)) return 'not-configured'
  if (typeof presented !== 'string' || !presented || presented.length > MAX_TOKEN_LENGTH) return 'bad'
  return timingSafeEqual(presented, configured) ? 'ok' : 'bad'
}

export function offeredDeviceProtocol(headers: Headers): string | null {
  const offered = (headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim())
  return offered.includes(DEVICE_PROTOCOL) ? DEVICE_PROTOCOL : null
}

export interface SocketAttachment {
  authed: boolean
  connectedAt: number
}

export function isAuthedAttachment(a: unknown): boolean {
  return !!a && typeof a === 'object' && (a as SocketAttachment).authed === true
}
