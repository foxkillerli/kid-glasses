import { describe, expect, it } from 'vitest'
import { DEVICES_KEY, MAX_PENDING, PAIR_TTL_MS, Pairing, START_LIMIT_PER_MIN, sha256Hex, type PairedDevice } from '../src/pairing'
import { FakeStorage } from './fakes'

function setup() {
  let now = 1_000_000
  const storage = new FakeStorage()
  const p = new Pairing({ storage, now: () => now })
  return { p, storage, advance: (ms: number) => (now += ms) }
}

async function started(p: Pairing, client = 'c1') {
  const r = await p.start(client)
  if (!r.ok) throw new Error('start failed')
  return r
}

describe('Pairing', () => {
  it('start returns a 6-digit code and a 128-bit pairId; poll is pending until Fox confirms, then mints a token once', async () => {
    const { p, storage } = setup()
    const s = await started(p)
    expect(s.code).toMatch(/^\d{6}$/)
    expect(s.pairId).toMatch(/^[0-9a-f]{32}$/)
    expect(await p.poll(s.pairId, 'c1')).toEqual({ status: 'pending', expiresAt: s.expiresAt })
    expect(await p.confirm(s.code)).toEqual({ ok: true })
    const paired = await p.poll(s.pairId, 'c1')
    expect(paired.status).toBe('paired')
    if (paired.status !== 'paired') return
    expect(paired.token).toMatch(/^kgd_[0-9a-f]{64}$/)
    const stored = (await storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []
    expect(stored).toHaveLength(1)
    expect(stored[0].hash).toBe(await sha256Hex(paired.token))
    expect(JSON.stringify([...storage.map.values()])).not.toContain(paired.token)
    expect(await p.poll(s.pairId, 'c1')).toEqual({ status: 'expired' })
    expect(await p.verify(paired.token)).toBe(paired.deviceId)
  })

  it('a code is single use: a second confirm of the same code fails', async () => {
    const { p } = setup()
    const s = await started(p)
    expect(await p.confirm(s.code)).toEqual({ ok: true })
    expect(await p.confirm(s.code)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('expires after 5 minutes: confirm and poll both fail', async () => {
    const { p, advance } = setup()
    const s = await started(p)
    advance(PAIR_TTL_MS + 1)
    expect(await p.confirm(s.code)).toEqual({ ok: false, reason: 'no-match' })
    expect(await p.poll(s.pairId, 'c1')).toEqual({ status: 'expired' })
  })

  it('an expired confirmed pairing cannot be collected', async () => {
    const { p, advance } = setup()
    const s = await started(p)
    await p.confirm(s.code)
    advance(PAIR_TTL_MS + 1)
    expect(await p.poll(s.pairId, 'c1')).toEqual({ status: 'expired' })
  })

  it('wrong codes count as failed attempts; 5 failures lock confirmations and clear pending pairings', async () => {
    const { p } = setup()
    const s = await started(p)
    const wrong = s.code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 4; i++) expect(await p.confirm(wrong)).toEqual({ ok: false, reason: 'no-match' })
    expect(await p.confirm(wrong)).toEqual({ ok: false, reason: 'locked' })
    expect(await p.confirm(s.code)).toEqual({ ok: false, reason: 'locked' })
    expect(await p.poll(s.pairId, 'c1')).toEqual({ status: 'expired' })
  })

  it('rate limits start per client per minute and caps active pairings', async () => {
    const { p, advance } = setup()
    for (let i = 0; i < START_LIMIT_PER_MIN; i++) expect((await p.start('a')).ok).toBe(true)
    expect(await p.start('a')).toEqual({ ok: false, error: 'rate-limited' })
    advance(61_000)
    expect((await p.start('b')).ok).toBe(true)
    expect((await p.start('b')).ok).toBe(true)
    expect(await p.start('c')).toEqual({ ok: false, error: 'busy' })
    expect(MAX_PENDING).toBe(5)
  })

  it('rate limits poll per client', async () => {
    const { p } = setup()
    const s = await started(p)
    let last
    for (let i = 0; i < 61; i++) last = await p.poll(s.pairId, 'c1')
    expect(last).toEqual({ status: 'rate-limited' })
  })

  it('verify rejects unknown, malformed and shared-style tokens; revokeAll removes every paired device', async () => {
    const { p } = setup()
    const s = await started(p)
    await p.confirm(s.code)
    const r = await p.poll(s.pairId, 'c1')
    if (r.status !== 'paired') throw new Error('not paired')
    expect(await p.verify('kgd_' + '0'.repeat(64))).toBeNull()
    expect(await p.verify('d'.repeat(40))).toBeNull()
    expect(await p.revokeAll()).toBe(1)
    expect(await p.verify(r.token)).toBeNull()
  })

  it('serialises concurrent polls so a confirmed pairing mints exactly one token', async () => {
    const { p, storage } = setup()
    const s = await started(p)
    await p.confirm(s.code)
    const results = await Promise.all([p.poll(s.pairId, 'c1'), p.poll(s.pairId, 'c2')])
    expect(results.filter(r => r.status === 'paired')).toHaveLength(1)
    expect(((await storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []).length).toBe(1)
  })
})
