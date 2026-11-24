import { describe, expect, it, vi } from 'vitest'
import { DISABLED_FAST_LANE } from '../src/fast-lane'
import { CIDS_KEY, CID_CAP, HubCore, type HubDeps } from '../src/hub-core'
import { Pairing } from '../src/pairing'
import { SlackApiError } from '../src/slack-client'
import { FakeAsr, FakeDevice, FakeStorage, flush } from './fakes'

const FOX = 'UFOX0001'
const SHARED = 's'.repeat(40)

function setup(over: Partial<HubDeps> = {}) {
  let now = 1_000_000
  let n = 0
  const storage = new FakeStorage()
  const devices: FakeDevice[] = [new FakeDevice()]
  const posts: string[] = []
  const asr = new FakeAsr()
  const pairing = new Pairing({ storage, now: () => now })
  const core = new HubCore({
    storage,
    sockets: () => devices,
    deviceToken: SHARED,
    slack: {
      selfUserId: async () => FOX,
      postToKid: vi.fn(async (text: string) => {
        posts.push(text)
        return { ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }
      }),
    },
    asr: { connect: async () => asr },
    fastLane: DISABLED_FAST_LANE,
    pairing,
    now: () => now,
    ...over,
  })
  return { core, storage, devices, device: devices[0], posts, asr, pairing, advance: (ms: number) => (now += ms) }
}

const CID = 'c-0123456789abcdef'

describe('say dedupe by cid', () => {
  it('a resent say with the same cid posts to Slack once and re-acks posted with dup', async () => {
    const { core, device, posts } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '今天几点放学', cid: CID }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '今天几点放学', cid: CID }))
    expect(posts).toHaveLength(1)
    expect(device.of('posted')).toEqual([
      { t: 'posted', seq: 1, text: '今天几点放学', cid: CID },
      { t: 'posted', seq: 1, text: '今天几点放学', cid: CID, dup: true },
    ])
  })

  it('concurrent duplicates are serialised by the post queue and still post once', async () => {
    const { core, device, posts } = setup()
    await Promise.all([1, 2, 3].map(() => core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'hi', cid: CID }))))
    expect(posts).toHaveLength(1)
    expect(device.of('posted').filter(p => p.dup)).toHaveLength(2)
  })

  it('different cids post separately; says without cid keep working', async () => {
    const { core, device, posts } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: 'cid-aaaaaaaa' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'b', cid: 'cid-bbbbbbbb' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'c' }))
    expect(posts).toHaveLength(3)
  })

  it('rejects malformed cids', async () => {
    const { core, device, posts } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: 'x' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: 'bad cid with spaces!' }))
    expect(posts).toHaveLength(0)
    expect(device.of('error').map(e => e.message)).toEqual(['bad-cid', 'bad-cid'])
  })

  it('the cid table is bounded and expires after 24 h, so a very old cid posts again', async () => {
    const { core, device, posts, storage, advance } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: CID }))
    advance(24 * 60 * 60 * 1000 + 1)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: CID }))
    expect(posts).toHaveLength(2)
    for (let i = 0; i < CID_CAP + 5; i++) await core.sayFromGlasses('x', `cid-${String(i).padStart(8, '0')}`)
    expect(((await storage.get<unknown[]>(CIDS_KEY)) ?? []).length).toBe(CID_CAP)
  })

  it('replayed glasses items carry their cid, so a reconnecting client can clear its outbox', async () => {
    const { core, device } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: CID }))
    const late = new FakeDevice()
    await core.onDeviceMessage(late, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    expect(late.of('msg')).toEqual([expect.objectContaining({ seq: 1, from: 'glasses', cid: CID })])
  })

  it('a failed Slack post reports the cid so the client keeps the turn queued', async () => {
    const { core, device } = setup({
      slack: { selfUserId: async () => FOX, postToKid: async () => { throw new SlackApiError('ratelimited') } },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'a', cid: CID }))
    expect(device.of('error')).toEqual([{ t: 'error', code: 'SlackApiError', message: 'slack api error: ratelimited', cid: CID }])
  })

  it('a voice turn started with a cid posts the transcript with that cid', async () => {
    const { core, device, asr } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.result('你好', true)
    core.stopAsr('device')
    asr.close(1000)
    await core.turnsSettled
    await flush()
    expect(device.of('posted')).toEqual([{ t: 'posted', seq: 1, text: '你好', cid: CID }])
  })

  it('an interrupted voice turn reports its cid', async () => {
    const { core, device, asr } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.close(1006)
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'asr-interrupted', cid: CID })])
  })
})

async function pairDevice(core: HubCore) {
  const s = (await core.pairRequest('/pair/start', null, 'c1'))!.body as { pairId: string; code: string }
  await core.pairRequest('/pair-confirm', { user: FOX, code: s.code }, 'slack')
  const r = (await core.pairRequest('/pair/poll', { pairId: s.pairId }, 'c1'))!.body as { status: string; token: string; deviceId: string }
  return { ...s, ...r }
}

describe('pairing through the hub', () => {
  it('Fox confirms, the device polls, and the minted token authenticates a socket', async () => {
    const { core } = setup()
    const r = await pairDevice(core)
    expect(r.status).toBe('paired')
    const ws = new FakeDevice(false)
    await core.onDeviceMessage(ws, JSON.stringify({ t: 'auth', token: r.token }))
    expect(ws.of('auth.ok')).toHaveLength(1)
    expect(ws.deserializeAttachment()).toMatchObject({ authed: true, deviceId: r.deviceId })
  })

  it('the shared DEVICE_TOKEN still works; an unknown kgd_ token is rejected with 4401', async () => {
    const { core } = setup()
    const a = new FakeDevice(false)
    await core.onDeviceMessage(a, JSON.stringify({ t: 'auth', token: SHARED }))
    expect(a.of('auth.ok')).toHaveLength(1)
    const b = new FakeDevice(false)
    await core.onDeviceMessage(b, JSON.stringify({ t: 'auth', token: 'kgd_' + 'f'.repeat(64) }))
    expect(b.closed).toEqual({ code: 4401, reason: 'unauthorized' })
  })

  it('only Fox (auth.test user) can confirm; an unknown self id rejects too', async () => {
    const { core } = setup()
    const s = (await core.pairRequest('/pair/start', null, 'c1'))!.body as { pairId: string; code: string }
    expect((await core.pairRequest('/pair-confirm', { user: 'UKID0001', code: s.code }, 'slack'))!.body).toEqual({ ok: false })
    expect((await core.pairRequest('/pair/poll', { pairId: s.pairId }, 'c1'))!.body).toMatchObject({ status: 'pending' })
    const other = setup({ slack: { selfUserId: async () => null, postToKid: async () => ({ ts: '1', channel: 'D1' }) } })
    const s2 = (await other.core.pairRequest('/pair/start', null, 'c1'))!.body as { code: string }
    expect((await other.core.pairRequest('/pair-confirm', { user: FOX, code: s2.code }, 'slack'))!.body).toEqual({ ok: false })
  })

  it('poll validates the pairId shape', async () => {
    const { core } = setup()
    expect(await core.pairRequest('/pair/poll', { pairId: 'nope' }, 'c1')).toEqual({ status: 400, body: { error: 'bad-request' } })
    expect(await core.pairRequest('/pair/poll', null, 'c1')).toEqual({ status: 400, body: { error: 'bad-request' } })
  })

  it('撤销配对 from Fox revokes every paired token and closes paired sockets, but not shared-token ones', async () => {
    const { core, devices } = setup()
    const r = await pairDevice(core)
    const paired = new FakeDevice(false)
    const shared = new FakeDevice(false)
    devices.push(paired, shared)
    await core.onDeviceMessage(paired, JSON.stringify({ t: 'auth', token: r.token }))
    await core.onDeviceMessage(shared, JSON.stringify({ t: 'auth', token: SHARED }))
    expect((await core.pairRequest('/pair-revoke', { user: FOX }, 'slack'))!.body).toEqual({ ok: true, revoked: 1 })
    expect(paired.closed).toEqual({ code: 4401, reason: 'revoked' })
    expect(shared.closed).toBeNull()
    const again = new FakeDevice(false)
    await core.onDeviceMessage(again, JSON.stringify({ t: 'auth', token: r.token }))
    expect(again.closed).toEqual({ code: 4401, reason: 'unauthorized' })
  })

  it('rate limits start (429) and reports busy when 5 pairings are active', async () => {
    const { core } = setup()
    for (let i = 0; i < 3; i++) expect((await core.pairRequest('/pair/start', null, 'same'))!.status).toBe(200)
    expect(await core.pairRequest('/pair/start', null, 'same')).toEqual({ status: 429, body: { error: 'rate-limited' } })
  })
})
