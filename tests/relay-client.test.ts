import { describe, expect, it } from 'vitest'
import { RelayClient, backoffDelay, type RelayEvents, type RelayItem, type RelayState } from '../src/lib/relay-client'
import { STORE_KEYS } from '../src/lib/relay-config'
import { MemoryStore } from '../src/lib/store'
import { FakeTimers, FakeWs, tick } from './relay-fakes'

function setup(opts: { token?: string | null; store?: MemoryStore; random?: number } = {}) {
  const timers = new FakeTimers()
  const store = opts.store ?? new MemoryStore()
  if (opts.token !== null) store.map.set(STORE_KEYS.token, opts.token ?? 'kgd_test')
  const sockets: FakeWs[] = []
  const states: Array<[RelayState, string]> = []
  const items: Array<[RelayItem[], string]> = []
  const errors: string[] = []
  let n = 0
  const events: Partial<RelayEvents> = {
    state: (s, d) => states.push([s, d]),
    items: (i, k) => items.push([i, k]),
    error: (code, _m, cid) => errors.push(`${code}:${cid ?? '-'}`),
  }
  const client = new RelayClient({
    url: 'wss://relay.test/device',
    ws: (url, protocols) => {
      const ws = new FakeWs(url, protocols)
      sockets.push(ws)
      return ws
    },
    store,
    timers,
    now: () => timers.now,
    random: () => opts.random ?? 0.5,
    uuid: () => `cid-${String(++n).padStart(8, '0')}`,
    events,
  })
  const last = () => sockets[sockets.length - 1]
  const online = async (upTo = 0) => {
    last().open()
    last().frame({ t: 'auth.ok' })
    last().frame({ t: 'replay.done', upTo })
    await tick()
  }
  return { client, timers, store, sockets, states, items, errors, last, online }
}

describe('RelayClient connection', () => {
  it('opens with kg.v1, authenticates first, then hello with the persisted lastSeq and a history request', async () => {
    const store = new MemoryStore()
    store.map.set(STORE_KEYS.lastSeq, '7')
    const { client, last, online, states } = setup({ store })
    await client.init()
    client.start()
    expect(last().protocols).toEqual(['kg.v1'])
    last().open()
    expect(last().json()).toEqual([{ t: 'auth', token: 'kgd_test' }])
    last().frame({ t: 'auth.ok' })
    expect(last().json().slice(1)).toEqual([{ t: 'hello', lastSeq: 7 }, { t: 'history', limit: 20 }])
    expect(states.map(s => s[0])).toEqual(['connecting', 'online'])
  })

  it('without a token it asks for pairing and never opens a socket', async () => {
    const { client, sockets, states } = setup({ token: null })
    await client.init()
    client.start()
    expect(sockets).toHaveLength(0)
    expect(states).toEqual([['need-pair', '']])
  })

  it('pings every 25 s and reconnects when nothing arrives for 70 s', async () => {
    const { client, timers, last, online, sockets } = setup()
    await client.init()
    client.start()
    await online()
    timers.advance(25_000)
    expect(last().types().filter(t => t === 'ping')).toHaveLength(1)
    last().frame({ t: 'pong' })
    timers.advance(50_000)
    expect(sockets).toHaveLength(1)
    timers.advance(50_000)
    expect(sockets[0].closedWith?.code).toBe(4000)
  })

  it('reconnects with exponential backoff and jitter, capped at 30 s, and resets after auth.ok', async () => {
    const { client, timers, last, online } = setup({ random: 1 })
    await client.init()
    client.start()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      last().drop(1006)
      delays.push(timers.pendingDelays()[0])
      timers.advance(delays[i])
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    await online()
    last().drop(1006)
    expect(timers.pendingDelays()[0]).toBe(1000)
    expect(backoffDelay(3, 0)).toBe(4000)
    expect(backoffDelay(3, 1)).toBe(8000)
  })

  it('nudge (visible / online / fgEnter) reconnects at once instead of waiting out the backoff', async () => {
    const { client, timers, last, sockets } = setup()
    await client.init()
    client.start()
    for (let i = 0; i < 4; i++) {
      last().drop()
      timers.advance(timers.pendingDelays()[0])
    }
    last().drop()
    const before = sockets.length
    client.nudge('visible')
    expect(sockets.length).toBe(before + 1)
    expect(timers.pendingDelays()).toEqual([10_000])
  })

  it('a 4401 close forgets the token and asks for pairing again, without reconnecting', async () => {
    const { client, store, last, states, sockets, timers } = setup()
    await client.init()
    client.start()
    last().drop(4401)
    await tick()
    expect(store.map.get(STORE_KEYS.token)).toBeUndefined()
    expect(states.at(-1)).toEqual(['need-pair', 'token rejected'])
    timers.advance(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('persists lastSeq from msg and posted frames', async () => {
    const { client, store, last, online } = setup()
    await client.init()
    client.start()
    await online()
    last().frame({ t: 'msg', seq: 4, from: 'kid', text: 'hi', at: 1, session: null })
    last().frame({ t: 'posted', seq: 5, text: 'mine' })
    await tick()
    expect(store.map.get(STORE_KEYS.lastSeq)).toBe('5')
    expect(client.seq).toBe(5)
  })
})

describe('RelayClient outbox: unacknowledged says are resent with the same cid', () => {
  it('a say made offline is kept, resent once after auth, and cleared by posted{cid}', async () => {
    const { client, last, online, store } = setup()
    await client.init()
    client.start()
    const cid = await client.say('今天几点放学')
    expect(last().types()).toEqual([])
    expect(JSON.parse(store.map.get(STORE_KEYS.outbox) as string)).toHaveLength(1)
    await online()
    const says = last().json().filter(m => m.t === 'say')
    expect(says).toEqual([{ t: 'say', text: '今天几点放学', cid }])
    last().frame({ t: 'posted', seq: 1, text: '今天几点放学', cid })
    expect(client.pending).toEqual([])
  })

  it('if the socket drops before posted arrives, the reconnect resends the same cid (the relay dedupes it)', async () => {
    const { client, last, online, timers } = setup()
    await client.init()
    client.start()
    await online()
    const cid = await client.say('a')
    last().drop()
    timers.advance(timers.pendingDelays()[0])
    await online()
    expect(last().json().filter(m => m.t === 'say')).toEqual([{ t: 'say', text: 'a', cid }])
    last().frame({ t: 'posted', seq: 1, text: 'a', cid, dup: true })
    expect(client.pending).toEqual([])
  })

  it('survives a page reload: a new client with the same store resends the stored cid', async () => {
    const store = new MemoryStore()
    const first = setup({ store })
    await first.client.init()
    first.client.start()
    const cid = await first.client.say('reload me')
    const second = setup({ store })
    await second.client.init()
    second.client.start()
    await second.online()
    expect(second.last().json().filter(m => m.t === 'say')).toEqual([{ t: 'say', text: 'reload me', cid }])
  })

  it('a replayed glasses item carrying the cid also clears the outbox', async () => {
    const { client, last, online } = setup()
    await client.init()
    client.start()
    const cid = await client.say('a')
    await online()
    last().frame({ t: 'msg', seq: 9, from: 'glasses', text: 'a', at: 1, session: 's', cid })
    expect(client.pending).toEqual([])
  })

  it('errors for a cid count as tries; after 4 the turn is dropped', async () => {
    const { client, last, online, timers, errors } = setup()
    await client.init()
    client.start()
    const cid = (await client.say('a')) as string
    for (let i = 0; i < 4; i++) {
      await online()
      last().frame({ t: 'error', code: 'SlackApiError', message: 'x', cid })
      if (i < 3) {
        last().drop()
        timers.advance(timers.pendingDelays()[0])
      }
    }
    expect(client.pending).toEqual([])
    expect(errors).toEqual(Array(4).fill(`SlackApiError:${cid}`))
  })
})

describe('RelayClient audio', () => {
  it('audio.start carries a cid and only works online; frames go out as binary', async () => {
    const { client, last, online } = setup()
    await client.init()
    client.start()
    expect(client.audioStart()).toBeNull()
    await online()
    const cid = client.audioStart()
    expect(cid).toMatch(/^cid-/)
    expect(client.audioFrame(new Uint8Array([1, 2]))).toBe(true)
    client.audioStop()
    const sent = last().sent
    expect(sent.some(d => d instanceof Uint8Array)).toBe(true)
    expect(last().json().filter(m => m.t.toString().startsWith('audio'))).toEqual([{ t: 'audio.start', cid }, { t: 'audio.stop' }])
  })
})

describe('RelayClient review fixes', () => {
  it('F04: a socket stuck in CONNECTING or waiting for auth.ok is dropped after 10 s and retried', async () => {
    const { client, timers, sockets } = setup()
    await client.init()
    client.start()
    timers.advance(10_000)
    expect(sockets[0].closedWith?.code).toBe(4000)
    expect(client.state).toBe('offline')
    timers.advance(timers.pendingDelays().find(d => d < 10_000) ?? 0)
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    timers.advance(10_000)
    expect(sockets[1].closedWith?.code).toBe(4000)
  })

  it('F04: nudge on an open socket probes with a ping and reconnects if nothing answers in 5 s', async () => {
    const { client, timers, sockets, online } = setup()
    await client.init()
    client.start()
    await online()
    client.nudge('visible')
    expect(sockets[0].types().at(-1)).toBe('ping')
    timers.advance(5_000)
    expect(sockets[0].closedWith?.code).toBe(4000)
    expect(sockets).toHaveLength(2)
  })

  it('F06: the persisted cursor only advances after replay.done, so a drop mid-replay leaves no gap', async () => {
    const { client, store, last, timers } = setup()
    await client.init()
    client.start()
    last().open()
    last().frame({ t: 'auth.ok' })
    last().frame({ t: 'msg', seq: 50, from: 'kid', text: 'live first', at: 1, session: null })
    expect(store.map.get(STORE_KEYS.lastSeq)).toBeUndefined()
    last().drop()
    timers.advance(timers.pendingDelays().find(d => d < 10_000) ?? 0)
    last().open()
    expect(last().json()[0]).toEqual({ t: 'auth', token: 'kgd_test' })
    last().frame({ t: 'auth.ok' })
    expect(last().json()[1]).toEqual({ t: 'hello', lastSeq: 0 })
    last().frame({ t: 'msg', seq: 49, from: 'kid', text: 'replayed', at: 1, session: null })
    last().frame({ t: 'replay.done', upTo: 49 })
    expect(store.map.get(STORE_KEYS.lastSeq)).toBe('49')
  })

  it('F05: a retryable Slack error is retried on the same socket after a backoff, with the same cid', async () => {
    const { client, last, online, timers } = setup()
    await client.init()
    client.start()
    await online()
    const cid = await client.say('retry me')
    last().frame({ t: 'error', code: 'slack-unreachable', message: 'x', cid })
    timers.advance(9_000)
    expect(last().json().filter(m => m.t === 'say')).toHaveLength(1)
    timers.advance(1_000)
    expect(last().json().filter(m => m.t === 'say')).toEqual([
      { t: 'say', text: 'retry me', cid },
      { t: 'say', text: 'retry me', cid },
    ])
  })

  it('F07: the outbox is saved before the say goes out, and a full outbox refuses new turns instead of dropping old ones', async () => {
    const { client, store, last, online } = setup()
    await client.init()
    client.start()
    await online()
    const cid = await client.say('saved first')
    expect(JSON.parse(store.map.get(STORE_KEYS.outbox) as string)[0].cid).toBe(cid)
    last().drop()
    for (let i = 0; i < 19; i++) await client.say(`m${i}`)
    expect(await client.say('one too many')).toBeNull()
    expect(client.pending[0].cid).toBe(cid)
  })

  it('F08: audioCancel sends audio.cancel', async () => {
    const { client, last, online } = setup()
    await client.init()
    client.start()
    await online()
    client.audioStart()
    client.audioCancel()
    expect(last().types().slice(-2)).toEqual(['audio.start', 'audio.cancel'])
  })
})

describe('RelayClient round 2', () => {
  it('F07-A: a say queued while a reconnect flushes is sent once per connection, not twice', async () => {
    const { client, last, online } = setup()
    await client.init()
    client.start()
    const pending = client.say('race')
    await online()
    const cid = await pending
    const says = last().json().filter(m => m.t === 'say')
    expect(says).toEqual([{ t: 'say', text: 'race', cid }])
  })
})


describe('RelayClient M3', () => {
  it('M3-3: turn.pending is adopted into the persisted outbox, resent as say with the same cid after the retry delay, and cleared by posted', async () => {
    const { client, store, last, online, timers } = setup()
    await client.init()
    client.start()
    await online()
    last().frame({ t: 'error', code: 'slack-unreachable', message: 'x', cid: 'voice-cid-0001' })
    last().frame({ t: 'turn.pending', cid: 'voice-cid-0001', text: '帮我记一下' })
    last().frame({ t: 'turn.pending', cid: 'voice-cid-0001', text: '帮我记一下' })
    expect(client.pending).toEqual([expect.objectContaining({ cid: 'voice-cid-0001', text: '帮我记一下' })])
    expect(JSON.parse(store.map.get(STORE_KEYS.outbox) as string)).toEqual([expect.objectContaining({ cid: 'voice-cid-0001' })])
    expect(last().json().filter(m => m.t === 'say')).toEqual([])
    timers.advance(10_000)
    expect(last().json().filter(m => m.t === 'say')).toEqual([{ t: 'say', text: '帮我记一下', cid: 'voice-cid-0001' }])
    last().frame({ t: 'posted', seq: 7, text: '帮我记一下', cid: 'voice-cid-0001' })
    expect(client.pending).toEqual([])
  })

  it('M3-3: a pending turn survives a reload and is flushed on the next connect; bad turn.pending frames are ignored', async () => {
    const a = setup()
    await a.client.init()
    a.client.start()
    await a.online()
    a.last().frame({ t: 'turn.pending', cid: 'bad cid!', text: 'x' })
    a.last().frame({ t: 'turn.pending', cid: 'voice-cid-0002', text: '   ' })
    a.last().frame({ t: 'turn.pending', cid: 'voice-cid-0003', text: 'x'.repeat(3001) })
    expect(a.client.pending).toEqual([])
    a.last().frame({ t: 'turn.pending', cid: 'voice-cid-0004', text: '重启后还在' })
    const b = setup({ store: a.store })
    await b.client.init()
    b.client.start()
    await b.online()
    expect(b.last().json().filter(m => m.t === 'say')).toEqual([{ t: 'say', text: '重启后还在', cid: 'voice-cid-0004' }])
  })

  it('M3-2: an auth-timeout error closes our side at once and reconnects; unauthorized forgets the token at once', async () => {
    const { client, sockets, last, states } = setup()
    await client.init()
    client.start()
    last().open()
    last().frame({ t: 'error', code: 'auth-timeout', message: 'x' })
    expect(sockets[0].closedWith).toEqual({ code: 1000, reason: 'bye' })
    expect(states.at(-1)?.[0]).toBe('offline')
    const s2 = setup()
    await s2.client.init()
    s2.client.start()
    s2.last().open()
    s2.last().frame({ t: 'error', code: 'unauthorized', message: 'x' })
    await tick()
    expect(s2.states.at(-1)?.[0]).toBe('need-pair')
    expect(s2.store.map.has(STORE_KEYS.token)).toBe(false)
  })
})

describe('RelayClient M3 round 2', () => {
  it('the outbox is flushed after replay.done, so a post the phone missed is acked by the replay instead of being resent', async () => {
    const { client, last, timers } = setup()
    await client.init()
    const cid = await client.say('已经发过了')
    client.start()
    last().open()
    last().frame({ t: 'auth.ok' })
    await tick()
    expect(last().json().filter(m => m.t === 'say')).toEqual([])
    last().frame({ t: 'msg', seq: 3, from: 'glasses', text: '已经发过了', at: 1, session: 's', cid })
    last().frame({ t: 'replay.done', upTo: 3 })
    expect(last().json().filter(m => m.t === 'say')).toEqual([])
    expect(client.pending).toEqual([])
    const other = await client.say('还没发')
    last().drop()
    timers.advance(30_000)
    last().open()
    last().frame({ t: 'auth.ok' })
    timers.advance(4_999)
    expect(last().json().filter(m => m.t === 'say')).toEqual([])
    timers.advance(1)
    expect(last().json().filter(m => m.t === 'say')).toEqual([{ t: 'say', text: '还没发', cid: other }])
  })
})
