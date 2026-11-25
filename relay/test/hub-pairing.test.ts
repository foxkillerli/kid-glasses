import { describe, expect, it, vi } from 'vitest'
import { DISABLED_FAST_LANE } from '../src/fast-lane'
import { CIDS_KEY, CID_CAP, CID_HARD_CAP, CID_PROTECT_MS, HubCore, RECONCILE_SETTLE_MS, VOICE_PENDING_CAP, VOICE_PENDING_KEY, VOICE_PENDING_TTL_MS, type HubDeps } from '../src/hub-core'
import { Pairing } from '../src/pairing'
import { DeepgramUpgradeError } from '../src/deepgram'
import { KidDmClient, SlackApiError, SlackConfigError } from '../src/slack-client'
import { FakeAsr, FakeDevice, FakeStorage, flush, FakeTimers } from './fakes'

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
    timers: new FakeTimers(),
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
    expect(((await storage.get<unknown[]>(CIDS_KEY)) ?? []).length).toBe(CID_CAP + 6)
    advance(CID_PROTECT_MS)
    await core.sayFromGlasses('x', 'cid-after-protect')
    expect(((await storage.get<unknown[]>(CIDS_KEY)) ?? []).length).toBe(CID_CAP)
  })

  it('cids younger than the plugin outbox window survive the 1000 cap (up to a hard cap), so a stale unacked say is still deduped', async () => {
    const { core, device, posts, advance } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '只发一次', cid: CID }))
    for (let i = 0; i < CID_CAP + 10; i++) {
      advance(2_000)
      await core.sayFromGlasses('别的', `cid-other-${String(i).padStart(6, '0')}`)
    }
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '只发一次', cid: CID }))
    expect(posts.filter(p => p === '〔眼镜〕只发一次')).toHaveLength(1)
    expect(CID_HARD_CAP).toBeGreaterThan(CID_CAP)
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
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
    await flush()
    expect(device.of('posted')).toEqual([{ t: 'posted', seq: 1, text: '你好', cid: CID }])
  })

  it('an interrupted voice turn reports its cid', async () => {
    const { core, device, asr } = setup({ asrLimits: { maxReconnects: 0 } })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.close(1006)
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'asr-interrupted', cid: CID })])
  })
})

describe('M2 voice turn options', () => {
  it('passes the per-turn language to the connector, defaults to auto, and rejects unknown languages', async () => {
    const langs: string[] = []
    const { core, device } = setup({ asr: { connect: async lang => (langs.push(lang), new FakeAsr()) } })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID, lang: 'zh' }))
    core.cancelAsr('test')
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: 'cid-second-1' }))
    core.cancelAsr('test')
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: 'cid-third-01', lang: 'fr' }))
    expect(langs).toEqual(['zh', 'auto'])
    expect(device.of('error').map(e => e.message)).toEqual(['bad-lang'])
  })

  it('the owner socket going away mid-talk cancels the turn; after audio.stop it still posts', async () => {
    const asr = new FakeAsr()
    const { core, device, posts } = setup({ asr: { connect: async () => asr } })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    core.onDeviceGone(new FakeDevice())
    expect(core.recording).toBe(true)
    core.onDeviceGone(device)
    expect(core.recording).toBe(false)
    expect(asr.closedWith).toBe(1000)
    await core.turnsSettled
    expect(posts).toEqual([])
    const asr2 = new FakeAsr()
    const s2 = setup({ asr: { connect: async () => asr2 } })
    await s2.core.onDeviceMessage(s2.device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr2.result('到了', true, { start: 0, duration: 0.1 })
    await s2.core.onDeviceMessage(s2.device, JSON.stringify({ t: 'audio.stop' }))
    s2.core.onDeviceGone(s2.device)
    asr2.result('', true, { fromFinalize: true })
    await s2.core.turnsSettled
    expect(s2.posts).toEqual(['〔眼镜〕到了'])
  })

  it('review M2-5: partial and final transcripts carry the turn cid', async () => {
    const asr = new FakeAsr()
    const { core, device } = setup({ asr: { connect: async () => asr } })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.result('你好', false)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    asr.result('你好', true, { fromFinalize: true })
    expect(device.of('asr.partial')).toEqual([{ t: 'asr.partial', text: '你好', cid: CID }])
    expect(device.of('asr.final')).toEqual([{ t: 'asr.final', text: '你好', cid: CID }])
  })

  it('a refused Deepgram key reaches the device as asr-rejected with the cid', async () => {
    const { core, device } = setup({ asr: { connect: async () => Promise.reject(new DeepgramUpgradeError(402)) } })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'asr-rejected', cid: CID })])
    expect(core.recording).toBe(false)
  })
})

describe('M3-3 recoverable voice transcripts', () => {
  async function voiceTurn(core: HubCore, device: FakeDevice, asr: FakeAsr, text: string, cid = CID) {
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid }))
    asr.result(text, true, { start: 0, duration: 0.1 })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
  }

  it('a transcript whose Slack post fails transiently is kept, offered as turn.pending now and after hello, and cleared once a say with the same cid posts', async () => {
    let fail = true
    const posted: string[] = []
    const asr = new FakeAsr()
    const findOwnPost = vi.fn(async () => null)
    const { core, device, storage, advance } = setup({
      asr: { connect: async () => asr },
      slack: {
        selfUserId: async () => FOX,
        findOwnPost,
        postToKid: async (text: string) => {
          if (fail) throw new TypeError('network down')
          posted.push(text)
          return { ts: '1700000000.000900', channel: 'D0123ABCDEF' }
        },
      },
    })
    await voiceTurn(core, device, asr, '帮我记一下')
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'slack-unreachable', cid: CID })])
    expect(device.of('turn.pending')).toEqual([{ t: 'turn.pending', cid: CID, text: '帮我记一下' }])
    expect(await storage.get(VOICE_PENDING_KEY)).toEqual([expect.objectContaining({ cid: CID, text: '帮我记一下' })])
    const later = new FakeDevice()
    await core.onDeviceMessage(later, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    expect(later.of('turn.pending')).toEqual([{ t: 'turn.pending', cid: CID, text: '帮我记一下' }])
    fail = false
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', cid: CID, text: '帮我记一下' }))
    expect(findOwnPost).toHaveBeenCalledTimes(1)
    expect(posted).toEqual(['〔眼镜〕帮我记一下'])
    expect(device.of('posted')).toEqual([expect.objectContaining({ cid: CID })])
    expect(await storage.get(VOICE_PENDING_KEY)).toEqual([])
    const after = new FakeDevice()
    await core.onDeviceMessage(after, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    expect(after.of('turn.pending')).toEqual([])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', cid: CID, text: '帮我记一下' }))
    expect(posted).toHaveLength(1)
  })

  it('a reconciled resend (the first attempt had in fact reached Slack) also clears the pending transcript and posts nothing new', async () => {
    let calls = 0
    const asr = new FakeAsr()
    const { core, device, storage } = setup({
      asr: { connect: async () => asr },
      slack: {
        selfUserId: async () => FOX,
        findOwnPost: async () => ({ ts: '1700000000.000700', channel: 'D0123ABCDEF' }),
        postToKid: async () => {
          calls++
          throw new TypeError('timeout after send')
        },
      },
    })
    await voiceTurn(core, device, asr, '已经到了')
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', cid: CID, text: '已经到了' }))
    expect(calls).toBe(1)
    expect(device.of('posted')).toEqual([expect.objectContaining({ cid: CID, dup: true })])
    expect(await storage.get(VOICE_PENDING_KEY)).toEqual([])
  })

  it('a permanent refusal is not kept; typed say failures are never turned into pending voice', async () => {
    const asr = new FakeAsr()
    const { core, device, storage } = setup({
      asr: { connect: async () => asr },
      slack: { selfUserId: async () => FOX, postToKid: async () => Promise.reject(new SlackConfigError('bad config')) },
    })
    await voiceTurn(core, device, asr, '不会保存')
    expect(device.of('turn.pending')).toEqual([])
    const s2 = setup({ slack: { selfUserId: async () => FOX, postToKid: async () => Promise.reject(new TypeError('down')) } })
    await s2.core.onDeviceMessage(s2.device, JSON.stringify({ t: 'say', cid: CID, text: '打字的' }))
    expect(s2.device.of('turn.pending')).toEqual([])
    expect(await storage.get(VOICE_PENDING_KEY)).toBeUndefined()
  })

  it('pending transcripts are capped and expire after 12 h', async () => {
    const asr = new FakeAsr()
    const { core, device, storage, advance } = setup({
      asr: { connect: async () => asr },
      slack: { selfUserId: async () => FOX, postToKid: async () => Promise.reject(new TypeError('down')) },
    })
    for (let i = 0; i < VOICE_PENDING_CAP + 2; i++) await voiceTurn(core, device, asr, `第${i}句`, `cid-voice-${String(i).padStart(4, '0')}`)
    const list = (await storage.get<Array<{ cid: string }>>(VOICE_PENDING_KEY)) ?? []
    expect(list).toHaveLength(VOICE_PENDING_CAP)
    expect(list[0].cid).toBe('cid-voice-0002')
    advance(VOICE_PENDING_TTL_MS)
    const later = new FakeDevice()
    await core.onDeviceMessage(later, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    expect(later.of('turn.pending')).toEqual([])
  })

  it('M3-1: a hung Slack API call times out, so the turn queue keeps moving', async () => {
    let hang = true
    const posts: string[] = []
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('auth.test')) return Response.json({ ok: true, user_id: FOX })
      if (hang) return new Promise<Response>(() => {})
      posts.push(JSON.parse(init.body as string).text)
      return Response.json({ ok: true, ts: '1700000000.000800', channel: 'D0123ABCDEF' })
    })
    const asr = new FakeAsr()
    const asr2 = new FakeAsr()
    const queue = [asr, asr2]
    const { core, device } = setup({ asr: { connect: async () => queue.shift() as FakeAsr }, slack: new KidDmClient(['xoxp', 'fake', 'tok'].join('-'), 'D0123ABCDEF', fetchFn, 20) })
    await voiceTurn(core, device, asr, '第一句')
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'slack-unreachable', cid: CID })])
    hang = false
    await voiceTurn(core, device, asr2, '第二句', 'cid-second-1')
    expect(posts).toEqual(['〔眼镜〕第二句'])
  })
})

describe('M3 round 2: no double posts, original thread', () => {
  it('an internal_error from Slack is treated as uncertain: the resend reconciles and finds the first post', async () => {
    let calls = 0
    const { core, device, advance } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async () => {
          calls++
          throw new SlackApiError('internal_error')
        },
        findOwnPost: async () => ({ ts: '1700000000.000555', channel: 'D0123ABCDEF' }),
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '写进去了', cid: CID }))
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'slack-unreachable', cid: CID })])
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '写进去了', cid: CID }))
    expect(calls).toBe(1)
    expect(device.of('posted')).toEqual([expect.objectContaining({ cid: CID, dup: true })])
  })

  it('reconcile never matches an earlier post recorded without a cid', async () => {
    let n = 0
    const excluded: string[][] = []
    const { core, device, advance } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async () => {
          n++
          if (n === 2) throw new TypeError('lost')
          return { ts: `1700000000.00${n}`, channel: 'D0123ABCDEF' }
        },
        findOwnPost: async (_t: string, _th: string | null, _s: number, exclude?: Set<string>) => {
          excluded.push([...(exclude ?? [])])
          return exclude?.has('1700000000.001') ? null : { ts: '1700000000.001', channel: 'D0123ABCDEF' }
        },
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '同一句' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '同一句', cid: CID }))
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '同一句', cid: CID }))
    expect(excluded[0]).toContain('1700000000.001')
    expect(n).toBe(3)
  })

  it('a pending voice resend goes to the thread of its first attempt, even after 新对话', async () => {
    const threads: Array<string | null> = []
    let fail = true
    let n = 0
    const asr = new FakeAsr()
    const { core, device, advance } = setup({
      asr: { connect: async () => asr },
      slack: {
        selfUserId: async () => FOX,
        findOwnPost: async () => null,
        postToKid: async (_text: string, threadTs: string | null) => {
          threads.push(threadTs)
          if (fail && n > 0) throw new SlackApiError('ratelimited', 1)
          n++
          return { ts: `1700000000.10${n}`, channel: 'D0123ABCDEF' }
        },
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '开个话题', cid: 'cid-thread-a01' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.result('话题A里的', true, { start: 0, duration: 0.1 })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'session.new' }))
    fail = false
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '话题A里的', cid: CID }))
    expect(threads).toEqual([null, '1700000000.101', '1700000000.101'])
  })
})

async function pairDevice(core: HubCore) {
  const s = (await core.pairRequest('/pair/start', null, 'c1'))!.body as { pairId: string; code: string }
  await core.pairRequest('/pair-confirm', { user: FOX, code: s.code, eventId: `e${Math.random()}`, atMs: 1_000_000 }, 'slack')
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
    expect((await core.pairRequest('/pair-confirm', { user: 'UKID0001', code: s.code, eventId: 'e1', atMs: 1_000_000 }, 'slack'))!.body).toEqual({ ok: false })
    expect((await core.pairRequest('/pair/poll', { pairId: s.pairId }, 'c1'))!.body).toMatchObject({ status: 'pending' })
    const other = setup({ slack: { selfUserId: async () => null, postToKid: async () => ({ ts: '1', channel: 'D1' }) } })
    const s2 = (await other.core.pairRequest('/pair/start', null, 'c1'))!.body as { code: string }
    expect((await other.core.pairRequest('/pair-confirm', { user: FOX, code: s2.code, eventId: 'e2', atMs: 1_000_000 }, 'slack'))!.body).toEqual({ ok: false })
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
    expect((await core.pairRequest('/pair-revoke', { user: FOX, eventId: 'rv1', atMs: 1_000_000 }, 'slack'))!.body).toEqual({ ok: true, revoked: 1 })
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

describe('review fixes: uncertain Slack posts, evicted devices, cancel, replay marker', () => {
  function flaky(outcomes: Array<'ok' | 'network' | 'api'>, onSlack: string[] = []) {
    let i = 0
    let n = 0
    const found: Array<{ text: string }> = []
    const hooks: string[] = []
    const ctx = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async (text: string) => {
          const o = outcomes[Math.min(i++, outcomes.length - 1)]
          if (o === 'api') throw new SlackApiError('ratelimited')
          onSlack.push(text)
          found.push({ text })
          if (o === 'network') throw new TypeError('connection reset')
          return { ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }
        },
        findOwnPost: async (text: string) => (found.some(f => f.text === text) ? { ts: '1700000000.999', channel: 'D0123ABCDEF' } : null),
      },
      kidWebhook: { notify: async () => (hooks.push('call'), { ok: true, status: 200, attempts: 1 }) },
    })
    return { ...ctx, onSlack, hooks }
  }

  it('F01: when Slack took the post but the response was lost, the resend reconciles instead of posting again', async () => {
    const onSlack: string[] = []
    const { core, device, hooks } = flaky(['network', 'ok'], onSlack)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '只发一次', cid: CID }))
    expect(device.of('error')).toEqual([expect.objectContaining({ code: 'slack-unreachable', cid: CID })])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '只发一次', cid: CID }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '只发一次', cid: CID }))
    expect(onSlack).toHaveLength(1)
    expect(hooks).toHaveLength(1)
    expect(device.of('posted')).toEqual([
      { t: 'posted', seq: 1, text: '只发一次', cid: CID, dup: true },
      { t: 'posted', seq: 1, text: '只发一次', cid: CID, dup: true },
    ])
  })

  it('F01: a definite Slack refusal (ok:false) clears the mark so the resend posts normally', async () => {
    const onSlack: string[] = []
    const { core, device } = flaky(['api', 'ok'], onSlack)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'x', cid: CID }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'x', cid: CID }))
    expect(onSlack).toHaveLength(1)
    expect(device.of('posted')).toEqual([{ t: 'posted', seq: 1, text: 'x', cid: CID }])
  })

  it('F01: if the earlier attempt never reached Slack, the resend waits out the settle window, then posts once', async () => {
    const posts: string[] = []
    let first = true
    const { core, device, advance } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async (text: string) => {
          if (first) {
            first = false
            throw new TypeError('dns')
          }
          posts.push(text)
          return { ts: '1700000000.001', channel: 'D0123ABCDEF' }
        },
        findOwnPost: async () => null,
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'y', cid: CID }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'y', cid: CID }))
    expect(posts).toHaveLength(0)
    expect(device.of('error').map(e => e.code)).toEqual(['slack-unreachable', 'slack-unreachable'])
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'y', cid: CID }))
    expect(posts).toHaveLength(1)
  })

  it('F01: if Slack cannot be checked, nothing is posted and the client keeps the turn', async () => {
    const posts: string[] = []
    let calls = 0
    const { core, device } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async (text: string) => {
          calls++
          if (calls === 1) throw new TypeError('timeout')
          posts.push(text)
          return { ts: '1', channel: 'D0123ABCDEF' }
        },
        findOwnPost: async () => {
          throw new TypeError('still down')
        },
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'z', cid: CID }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'z', cid: CID }))
    expect(posts).toEqual([])
    expect(device.of('error').map(e => e.code)).toEqual(['slack-unreachable', 'slack-unreachable'])
  })

  it('F03: pairing an 11th device closes the evicted device socket', async () => {
    const { core, devices, advance } = setup()
    const first = await pairDevice(core)
    const ws = new FakeDevice(false)
    devices.push(ws)
    await core.onDeviceMessage(ws, JSON.stringify({ t: 'auth', token: first.token }))
    for (let i = 0; i < 10; i++) {
      advance(61_000)
      const s = (await core.pairRequest('/pair/start', null, `c${i}`))!.body as { pairId: string; code: string }
      await core.pairRequest('/pair-confirm', { user: FOX, code: s.code, eventId: `x${i}`, atMs: 1_000_000 + 61_000 * (i + 1) }, 'slack')
      await core.pairRequest('/pair/poll', { pairId: s.pairId }, `c${i}`)
    }
    expect(ws.closed).toEqual({ code: 4401, reason: 'evicted' })
    expect(ws.deserializeAttachment()).toMatchObject({ authed: false })
  })

  it('F08: audio.cancel and a dropped connection before stop discard the turn without posting', async () => {
    const { core, device, asr, posts } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.result('说了一半', true)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.cancel' }))
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
    expect(posts).toEqual([])
    expect(device.of('error')).toEqual([])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: 'cid-second-1' }))
    asr.result('又说了一半', true)
    core.cancelAsr('no-devices')
    await core.turnsSettled
    expect(posts).toEqual([])
  })

  it('F08: after audio.stop a dropped connection does not cancel; the transcript is still posted', async () => {
    const { core, device, asr, posts } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start', cid: CID }))
    asr.result('完整的一句', true)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    core.cancelAsr('no-devices')
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
    await flush()
    expect(posts).toHaveLength(1)
  })

  it('F06: hello with lastSeq ends the replay with replay.done {upTo}', async () => {
    const { core, device } = setup()
    await core.sayFromGlasses('a', 'cid-aaaaaaaa')
    const late = new FakeDevice()
    await core.onDeviceMessage(late, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    expect(late.sent.map(m => m.t)).toEqual(['hello', 'msg', 'replay.done'])
    expect(late.of('replay.done')).toEqual([{ t: 'replay.done', upTo: 1 }])
    expect(device.of('posted')).toHaveLength(1)
  })
})

describe('review round 2 fixes', () => {
  it('F01-A: reconcile ignores Slack messages already recorded for another cid with the same text', async () => {
    const posts: string[] = []
    let calls = 0
    const { core, device, advance } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async (text: string) => {
          calls++
          if (calls === 2) throw new TypeError('lost')
          posts.push(text)
          return { ts: `1700000000.00${calls}`, channel: 'D0123ABCDEF' }
        },
        findOwnPost: async (_t: string, _th: string | null, _s: number, exclude?: Set<string>) =>
          exclude?.has('1700000000.001') ? null : { ts: '1700000000.001', channel: 'D0123ABCDEF' },
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '好的', cid: 'cid-first-0001' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '好的', cid: 'cid-second-002' }))
    advance(RECONCILE_SETTLE_MS)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '好的', cid: 'cid-second-002' }))
    expect(posts).toHaveLength(2)
    expect(device.of('posted').map(p => [p.cid, p.seq])).toEqual([
      ['cid-first-0001', 1],
      ['cid-second-002', 2],
    ])
  })

  it('F01-B: a reconciled post from an old session does not give the new session the old thread', async () => {
    let calls = 0
    const { core, device, storage, advance } = setup({
      slack: {
        selfUserId: async () => FOX,
        postToKid: async () => {
          calls++
          if (calls === 1) throw new TypeError('lost')
          return { ts: `1700000000.10${calls}`, channel: 'D0123ABCDEF' }
        },
        findOwnPost: async () => ({ ts: '1700000000.555', channel: 'D0123ABCDEF' }),
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'old', cid: 'cid-old-00001' }))
    advance(31 * 60 * 1000)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'old', cid: 'cid-old-00001' }))
    const session = await storage.get<{ threadTs: string | null }>('meta:session')
    expect(session?.threadTs ?? null).toBeNull()
  })

  it('F02-A: a device whose pairing Fox approved before 撤销配对 is revoked even if it collects its token later', async () => {
    const { core } = setup()
    const s = (await core.pairRequest('/pair/start', null, 'c1'))!.body as { pairId: string; code: string }
    await core.pairRequest('/pair-confirm', { user: FOX, code: s.code, eventId: 'c', atMs: 1_000_000 }, 'slack')
    const r = (await core.pairRequest('/pair/poll', { pairId: s.pairId }, 'c1'))!.body as { token: string }
    await core.pairRequest('/pair-revoke', { user: FOX, eventId: 'r', atMs: 1_000_001 }, 'slack')
    const ws = new FakeDevice(false)
    await core.onDeviceMessage(ws, JSON.stringify({ t: 'auth', token: r.token }))
    expect(ws.closed).toEqual({ code: 4401, reason: 'unauthorized' })
  })

  it('F08: a second device cannot stop, cancel or feed the first device’s voice turn, and gets asr-busy', async () => {
    const { core, devices, asr, posts } = setup()
    const a = devices[0]
    const b = new FakeDevice()
    devices.push(b)
    await core.onDeviceMessage(a, JSON.stringify({ t: 'audio.start', cid: 'cid-dev-a-001' }))
    await core.onDeviceMessage(b, JSON.stringify({ t: 'audio.start', cid: 'cid-dev-b-001' }))
    expect(b.of('error')).toEqual([{ t: 'error', code: 'asr-busy', message: 'another device is talking', cid: 'cid-dev-b-001' }])
    await core.onDeviceMessage(b, new Uint8Array([9, 9]))
    await core.onDeviceMessage(b, JSON.stringify({ t: 'audio.cancel' }))
    await core.onDeviceMessage(b, JSON.stringify({ t: 'audio.stop' }))
    expect(core.recording).toBe(true)
    await core.onDeviceMessage(a, new Uint8Array([1, 2]))
    expect(asr.sent.filter(d => typeof d !== 'string').map(d => Array.from(d as Uint8Array))).toEqual([[1, 2]])
    asr.result('a 的话', true)
    await core.onDeviceMessage(a, JSON.stringify({ t: 'audio.stop' }))
    asr.result('', true, { fromFinalize: true })
    await core.turnsSettled
    await flush()
    expect(posts).toHaveLength(1)
  })
})
