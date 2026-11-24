import { describe, expect, it } from 'vitest'
import { KidWebhookClient, kidWebhookConfigured, kidWebhookSignature, type KidWebhookPayload } from '../src/kid-webhook'
import { configStatus, type Env } from '../src/env'

const KEY = '0123456789abcdef'.repeat(4)
const PAYLOAD: KidWebhookPayload = {
  v: 1,
  source: 'kid-glasses',
  session: 's1',
  channel: 'D0123ABCDEF',
  thread_ts: '1700000000.000100',
  message_ts: '1700000000.000100',
  text: '今天几点放学',
  at: 1700000000000,
}
const BODY = '{"v":1,"source":"kid-glasses","session":"s1","channel":"D0123ABCDEF","thread_ts":"1700000000.000100","message_ts":"1700000000.000100","text":"今天几点放学","at":1700000000000}'
const PY_VECTOR = '553e8eb79f458aabd16a71dcda1801ae093ac3646523f389d89f65e4a3315426'
const PY_VECTOR_IF_HEX_DECODED = '6ad64d9404ecfc4832c75c156910c2c3ab5d63603b69d2b2e1b5d00e8e25f67d'
const URL_ = 'https://kid.example.test/hook'

interface Call { url: string; headers: Record<string, string>; body: string }

function recorder(statuses: Array<number | 'network' | 'hang'>) {
  const calls: Call[] = []
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as string })
    const s = statuses[Math.min(calls.length - 1, statuses.length - 1)]
    if (s === 'network') throw new TypeError('network down')
    if (s === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    }
    return new Response('x', { status: s })
  }
  return { calls, fetchFn }
}

const client = (statuses: Array<number | 'network' | 'hang'>, timeoutMs = 10_000) => {
  const r = recorder(statuses)
  const sleeps: number[] = []
  const c = new KidWebhookClient(URL_, KEY, { fetchFn: r.fetchFn, nowMs: () => 1700000000_999, timeoutMs, sleep: async ms => void sleeps.push(ms) })
  return { c, sleeps, ...r }
}

describe('kid webhook signature', () => {
  it('matches an independent Python HMAC vector, keyed by the secret string as UTF-8 (not hex-decoded)', async () => {
    expect(JSON.stringify(PAYLOAD)).toBe(BODY)
    const sig = await kidWebhookSignature(KEY, 1700000000, BODY)
    expect(sig).toBe(`t=1700000000,v1=${PY_VECTOR}`)
    expect(sig).not.toContain(PY_VECTOR_IF_HEX_DECODED)
  })
})

describe('KidWebhookClient', () => {
  it('POSTs the exact signed JSON body with Content-Type and X-Kid-Signature', async () => {
    const { c, calls } = client([200])
    expect(await c.notify(PAYLOAD)).toEqual({ ok: true, status: 200, attempts: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(URL_)
    expect(calls[0].body).toBe(BODY)
    expect(calls[0].headers['Content-Type']).toBe('application/json')
    expect(calls[0].headers['X-Kid-Signature']).toBe(`t=1700000000,v1=${PY_VECTOR}`)
  })

  it('retries once on 5xx, then reports the final status', async () => {
    const ok = client([503, 200])
    expect(await ok.c.notify(PAYLOAD)).toEqual({ ok: true, status: 200, attempts: 2 })
    expect(ok.sleeps).toEqual([500])
    const bad = client([500, 502, 200])
    expect(await bad.c.notify(PAYLOAD)).toEqual({ ok: false, status: 502, attempts: 2 })
    expect(bad.calls).toHaveLength(2)
  })

  it('retries once on a network error, and gives up after the second', async () => {
    const r = client(['network', 'network'])
    expect(await r.c.notify(PAYLOAD)).toEqual({ ok: false, status: null, attempts: 2 })
    expect(r.calls).toHaveLength(2)
  })

  it('does not retry 4xx', async () => {
    const r = client([401])
    expect(await r.c.notify(PAYLOAD)).toEqual({ ok: false, status: 401, attempts: 1 })
    expect(r.calls).toHaveLength(1)
  })

  it('aborts a hung request after the timeout and retries once', async () => {
    const r = client(['hang', 'hang'], 20)
    expect(await r.c.notify(PAYLOAD)).toEqual({ ok: false, status: null, attempts: 2 })
  })
})

describe('kidWebhook health flag', () => {
  const base = { HUB: {} } as unknown as Env
  it('is true only when both URL (https) and secret are set', () => {
    expect(configStatus(base).kidWebhook).toBe(false)
    expect(configStatus({ ...base, KID_WEBHOOK_URL: URL_ }).kidWebhook).toBe(false)
    expect(configStatus({ ...base, KID_WEBHOOK_SECRET: KEY }).kidWebhook).toBe(false)
    expect(configStatus({ ...base, KID_WEBHOOK_URL: 'http://plain.test', KID_WEBHOOK_SECRET: KEY }).kidWebhook).toBe(false)
    expect(configStatus({ ...base, KID_WEBHOOK_URL: URL_, KID_WEBHOOK_SECRET: KEY }).kidWebhook).toBe(true)
    expect(kidWebhookConfigured(URL_, '')).toBe(false)
  })
})
