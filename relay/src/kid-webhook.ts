export const KID_WEBHOOK_TIMEOUT_MS = 10_000
export const KID_WEBHOOK_RETRY_DELAY_MS = 500

export interface KidWebhookPayload {
  v: 1
  source: 'kid-glasses'
  session: string
  channel: string
  thread_ts: string
  message_ts: string
  text: string
  at: number
}

export type KidWebhookResult = { ok: true; status: number; attempts: number } | { ok: false; status: number | null; attempts: number }

export interface KidWebhook {
  notify(payload: KidWebhookPayload): Promise<KidWebhookResult>
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
}

export async function kidWebhookSignature(secret: string, t: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${rawBody}`))
  return `t=${t},v1=${toHex(mac)}`
}

export function kidWebhookConfigured(url: string | undefined, secret: string | undefined): boolean {
  return !!secret && !!url && url.startsWith('https://')
}

export interface KidWebhookOptions {
  fetchFn?: FetchFn
  nowMs?: () => number
  timeoutMs?: number
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export class KidWebhookClient implements KidWebhook {
  private readonly fetchFn: FetchFn
  private readonly nowMs: () => number
  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    private readonly url: string,
    private readonly secret: string,
    opts: KidWebhookOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? ((i, init) => fetch(i, init))
    this.nowMs = opts.nowMs ?? (() => Date.now())
    this.timeoutMs = opts.timeoutMs ?? KID_WEBHOOK_TIMEOUT_MS
    this.retryDelayMs = opts.retryDelayMs ?? KID_WEBHOOK_RETRY_DELAY_MS
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  private async attempt(body: string): Promise<{ status: number | null }> {
    const t = Math.floor(this.nowMs() / 1000)
    const signature = await kidWebhookSignature(this.secret, t, body)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kid-Signature': signature },
        body,
        signal: ctrl.signal,
      })
      return { status: res.status }
    } catch {
      return { status: null }
    } finally {
      clearTimeout(timer)
    }
  }

  async notify(payload: KidWebhookPayload): Promise<KidWebhookResult> {
    const body = JSON.stringify(payload)
    let r = await this.attempt(body)
    let attempts = 1
    const retryable = (s: number | null) => s === null || s >= 500
    if (retryable(r.status)) {
      await this.sleep(this.retryDelayMs)
      r = await this.attempt(body)
      attempts = 2
    }
    if (r.status !== null && r.status >= 200 && r.status < 300) return { ok: true, status: r.status, attempts }
    return { ok: false, status: r.status, attempts }
  }
}
