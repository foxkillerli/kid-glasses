export const MAX_SKEW_SECONDS = 300

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  let diff = ab.length ^ bb.length
  const n = Math.max(ab.length, bb.length)
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

export async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestamp}:${body}`))
  return `v0=${toHex(mac)}`
}

export interface VerifyInput {
  secret: string | undefined
  timestamp: string | null
  signature: string | null
  body: string
  nowSeconds: number
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'no-secret' | 'missing-headers' | 'stale' | 'bad-signature' }

export async function verifySlackRequest(v: VerifyInput): Promise<VerifyResult> {
  if (!v.secret) return { ok: false, reason: 'no-secret' }
  if (!v.timestamp || !v.signature) return { ok: false, reason: 'missing-headers' }
  const ts = Number(v.timestamp)
  if (!Number.isFinite(ts) || Math.abs(v.nowSeconds - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: 'stale' }
  const expected = await slackSignature(v.secret, v.timestamp, v.body)
  return timingSafeEqual(expected, v.signature) ? { ok: true } : { ok: false, reason: 'bad-signature' }
}
