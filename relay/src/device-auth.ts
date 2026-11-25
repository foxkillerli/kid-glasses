import { timingSafeEqual } from './slack-verify'

export const DEVICE_PROTOCOL = 'kg.v1'
export const MIN_DEVICE_TOKEN_LENGTH = 32
export const AUTH_TIMEOUT_MS = 10_000
export const AUTH_ALARM_SLACK_MS = 100
export const CLOSE_AUTH_TIMEOUT = 4408
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

export interface SweepSocket {
  send(data: string): void
  deserializeAttachment(): unknown
  readonly readyState?: number
}

export interface SweepResult<W> {
  expired: W[]
  nextAlarmAt: number | null
}

export function sweepUnauthed<W extends SweepSocket>(sockets: W[], now: number, onSkip: (err: unknown) => void = () => {}): SweepResult<W> {
  const expired: W[] = []
  let next: number | null = null
  for (const ws of sockets) {
    if (ws.readyState !== undefined && ws.readyState !== 1) continue
    try {
      const a = ws.deserializeAttachment() as SocketAttachment | null
      if (isAuthedAttachment(a)) continue
      const deadline = (a?.connectedAt ?? 0) + AUTH_TIMEOUT_MS
      if (!a || now >= deadline) expired.push(ws)
      else next = Math.min(next ?? Infinity, deadline + AUTH_ALARM_SLACK_MS)
    } catch (err) {
      onSkip(err)
    }
  }
  return { expired, nextAlarmAt: next }
}

export const AUTH_TIMEOUT_FRAME = JSON.stringify({ t: 'error', code: 'auth-timeout', message: 'send {"t":"auth","token":…} as the first frame within 10 s' })
