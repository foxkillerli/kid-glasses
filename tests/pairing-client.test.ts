import { describe, expect, it, vi } from 'vitest'
import { PairingClient, type PairView } from '../src/lib/pairing-client'
import { STORE_KEYS } from '../src/lib/relay-config'
import { MemoryStore } from '../src/lib/store'
import { FakeTimers, tick } from './relay-fakes'

const PAIR_ID = 'a'.repeat(32)

function setup(responses: Array<[number, unknown] | 'throw'>, store = new MemoryStore()) {
  const timers = new FakeTimers()
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
  const views: PairView[] = []
  const tokens: string[] = []
  let i = 0
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> })
    const r = responses[Math.min(i++, responses.length - 1)]
    if (r === 'throw') throw new TypeError('offline')
    return Response.json(r[1], { status: r[0] })
  })
  const client = new PairingClient({
    origin: 'https://relay.test',
    fetch: fetchFn,
    store,
    now: () => timers.now,
    pollMs: 2500,
    timers,
    onView: v => views.push({ ...v }),
    onToken: async t => void tokens.push(t),
  })
  const run = async (ms: number) => {
    timers.advance(ms)
    for (let k = 0; k < 5; k++) await tick()
  }
  return { client, timers, calls, views, tokens, store, run }
}

describe('PairingClient', () => {
  it('starts, shows the code, polls until paired, hands over the token once and clears saved state', async () => {
    const { client, calls, views, tokens, store, run, timers } = setup([
      [200, { pairId: PAIR_ID, code: '123456', expiresAt: 1_000_000 + 300_000 }],
      [200, { status: 'pending', expiresAt: 1_300_000 }],
      [200, { status: 'paired', token: 'kgd_abc', deviceId: 'd1' }],
    ])
    await client.begin()
    expect(views.at(-1)).toMatchObject({ phase: 'waiting', code: '123456' })
    expect(JSON.parse(store.map.get(STORE_KEYS.pairing) as string).pairId).toBe(PAIR_ID)
    await run(2500)
    await run(2500)
    expect(tokens).toEqual(['kgd_abc'])
    expect(views.at(-1)?.phase).toBe('paired')
    expect(store.map.has(STORE_KEYS.pairing)).toBe(false)
    expect(calls.map(c => c.url)).toEqual(['https://relay.test/pair/start', 'https://relay.test/pair/poll', 'https://relay.test/pair/poll'])
    expect(JSON.parse(calls[1].body)).toEqual({ pairId: PAIR_ID })
    expect(calls[0].headers['Content-Type']).toBe('text/plain')
    expect(timers.pendingDelays()).toEqual([])
  })

  it('resumes the saved pairing after a page reload instead of asking for a new code', async () => {
    const store = new MemoryStore()
    store.map.set(STORE_KEYS.pairing, JSON.stringify({ pairId: PAIR_ID, code: '654321', expiresAt: 1_200_000 }))
    const { client, calls, views, run } = setup([[200, { status: 'pending', expiresAt: 1_200_000 }]], store)
    await client.begin()
    expect(views[0]).toMatchObject({ phase: 'waiting', code: '654321' })
    await run(0)
    expect(calls.map(c => c.url)).toEqual(['https://relay.test/pair/poll'])
  })

  it('reports expiry from the relay and from the local clock', async () => {
    const a = setup([[200, { pairId: PAIR_ID, code: '111111', expiresAt: 1_300_000 }], [200, { status: 'expired' }]])
    await a.client.begin()
    await a.run(2500)
    expect(a.views.at(-1)?.phase).toBe('expired')
    const b = setup([[200, { pairId: PAIR_ID, code: '222222', expiresAt: 1_001_000 }]])
    await b.client.begin()
    await b.run(2500)
    expect(b.views.at(-1)?.phase).toBe('expired')
  })

  it('shows rate limiting and network errors, and backs off polling on 429', async () => {
    const limited = setup([[429, { error: 'rate-limited' }]])
    await limited.client.begin()
    expect(limited.views.at(-1)).toMatchObject({ phase: 'error' })
    const offline = setup(['throw'])
    await offline.client.begin()
    expect(offline.views.at(-1)).toMatchObject({ phase: 'error', detail: '网络不通' })
    const slow = setup([[200, { pairId: PAIR_ID, code: '333333', expiresAt: 1_300_000 }], [429, { status: 'rate-limited' }]])
    await slow.client.begin()
    await slow.run(2500)
    expect(slow.timers.pendingDelays()).toEqual([10_000])
  })

  it('restart drops the old pairing and fetches a fresh code', async () => {
    const { client, calls } = setup([[200, { pairId: PAIR_ID, code: '444444', expiresAt: 1_300_000 }]])
    await client.begin()
    await client.restart()
    expect(calls.filter(c => c.url.endsWith('/pair/start'))).toHaveLength(2)
  })
})
