import { describe, expect, it, vi } from 'vitest'
import { DISABLED_FAST_LANE, type FastLane } from '../src/fast-lane'
import { HubCore, SESSION_IDLE_MS, type HubDeps } from '../src/hub-core'
import { FINALIZE } from '../src/deepgram'
import { ChannelNotAllowedError } from '../src/slack-client'
import type { KidMessage } from '../src/slack-events'
import type { KidWebhook, KidWebhookPayload, KidWebhookResult } from '../src/kid-webhook'
import { FakeAsr, FakeDevice, FakeStorage, flush, FakeTimers } from './fakes'

function setup(over: Partial<HubDeps> = {}) {
  const device = new FakeDevice()
  let now = 1_000_000
  let tsCounter = 100
  const posts: Array<{ text: string; threadTs: string | null }> = []
  const asr = new FakeAsr()
  const deps: HubDeps = {
    storage: new FakeStorage(),
    sockets: () => [device],
    slack: {
        selfUserId: async () => null,
      postToKid: vi.fn(async (text: string, threadTs: string | null) => {
        posts.push({ text, threadTs })
        return { ts: `1700000000.000${tsCounter++}`, channel: 'D0123ABCDEF' }
      }),
    },
    asr: { connect: async () => asr },
    timers: new FakeTimers(),
    fastLane: DISABLED_FAST_LANE,
    now: () => now,
    ...over,
  }
  const core = new HubCore(deps)
  return { core, device, posts, asr, deps, advance: (ms: number) => (now += ms) }
}

describe('HubCore', () => {
  it('posts glasses speech with the 〔眼镜〕 prefix, one thread per session', async () => {
    const { core, device, posts, advance } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '今天几点放学' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '要带伞吗' }))
    expect(posts).toEqual([
      { text: '〔眼镜〕今天几点放学', threadTs: null },
      { text: '〔眼镜〕要带伞吗', threadTs: '1700000000.000100' },
    ])
    advance(SESSION_IDLE_MS + 1)
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '新话题' }))
    expect(posts[2]).toEqual({ text: '〔眼镜〕新话题', threadTs: null })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'session.new' }))
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '再来' }))
    expect(posts[3].threadTs).toBeNull()
    expect(device.of('posted').map(m => m.text)).toEqual(['今天几点放学', '要带伞吗', '新话题', '再来'])
  })

  it('pushes Kid replies to the device once, sanitised, and stores them in history', async () => {
    const { core, device } = setup()
    const msg = { eventId: 'Ev1', channel: 'D0123ABCDEF', user: 'UKID', text: '*三点半* 放学 :smile:', ts: '1.2', threadTs: null, botId: null, kind: 'message' as const, verifiedKid: false }
    await core.onKidMessage(msg)
    await core.onKidMessage(msg)
    expect(device.of('msg')).toEqual([{ t: 'msg', seq: 1, from: 'kid', text: '三点半 放学', at: 1_000_000, session: null }])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'history', limit: 10 }))
    expect(device.of('history')[0]).toMatchObject({ more: false, items: [{ seq: 1, from: 'kid', text: '三点半 放学' }] })
  })

  it('replays missed messages after hello with lastSeq', async () => {
    const { core, device } = setup()
    for (const id of ['E1', 'E2', 'E3']) await core.onKidMessage({ eventId: id, channel: 'D0123ABCDEF', user: 'U', text: id, ts: id, threadTs: null, botId: null, kind: 'message' as const, verifiedKid: false })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'hello', lastSeq: 1 }))
    expect(device.of('hello')[0]).toMatchObject({ lastSeq: 3, fastLane: false })
    expect(device.of('msg').slice(-2).map(m => m.text)).toEqual(['E2', 'E3'])
  })

  it('reports Slack refusals to the device instead of posting', async () => {
    const { core, device } = setup({
      slack: {
        selfUserId: async () => null,
        postToKid: async () => {
          throw new ChannelNotAllowedError()
        },
      },
    })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'hi' }))
    expect(device.of('error')[0]).toMatchObject({ code: 'ChannelNotAllowedError' })
    expect(await core.history.lastSeq()).toBe(0)
  })

  it('streams audio to the ASR socket, shows partials, and posts the final transcript', async () => {
    const { core, device, posts, asr } = setup()
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    const frame = new Uint8Array(3200)
    await core.onDeviceMessage(device, frame)
    expect(asr.sent).toEqual([frame])
    asr.result('今天', false)
    asr.result('今天几点放学', true)
    expect(device.of('asr.partial').map(m => m.text)).toEqual(['今天', '今天几点放学'])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    expect(asr.sent.at(-1)).toBe(FINALIZE)
    await core.onDeviceMessage(device, new Uint8Array(10))
    expect(asr.sent).toHaveLength(2)
    asr.result('', true, { fromFinalize: true })
    await flush()
    expect(device.of('asr.final')).toEqual([{ t: 'asr.final', text: '今天几点放学' }])
    expect(posts).toEqual([{ text: '〔眼镜〕今天几点放学', threadTs: null }])
  })

  it('buffers frames that arrive before the ASR socket connects', async () => {
    const asr = new FakeAsr()
    let release: () => void = () => {}
    const { core, device } = setup({ asr: { connect: () => new Promise(r => (release = () => r(asr))) } })
    const started = core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    core.onAudioFrame(new Uint8Array(4))
    core.stopAsr('test')
    release()
    await started
    expect(asr.sent).toEqual([new Uint8Array(4), FINALIZE])
  })

  it('reports a missing Deepgram key and rejects malformed device messages', async () => {
    const { core, device } = setup({ asr: null })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    await core.onDeviceMessage(device, '{bad')
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: '' }))
    expect(device.of('error').map(m => m.code)).toEqual(['asr-not-configured', 'bad-message', 'bad-message'])
  })

  it('keeps the fast-answer lane off by default and never calls it', async () => {
    const answer = vi.fn(async () => 'fast')
    const off: FastLane = { enabled: false, answer }
    const { core, device } = setup({ fastLane: off })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'hi' }))
    expect(answer).not.toHaveBeenCalled()
    expect(device.of('msg')).toHaveLength(0)
  })

  it('adds a fast answer only when the lane is explicitly enabled', async () => {
    const on: FastLane = { enabled: true, answer: async q => `re: ${q}` }
    const { core, device } = setup({ fastLane: on })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'say', text: 'hi' }))
    expect(device.of('msg')).toMatchObject([{ from: 'fast', text: 're: hi' }])
  })
})

describe('HubCore ordering', () => {
  it('serialises concurrent posts so one session never opens two threads', async () => {
    const posts: Array<string | null> = []
    let n = 0
    const storage = new FakeStorage()
    const device = new FakeDevice()
    const core = new HubCore({
      storage,
      sockets: () => [device],
      slack: {
        selfUserId: async () => null,
        postToKid: async (_text, threadTs) => {
          posts.push(threadTs)
          await new Promise(r => setTimeout(r, 5))
          return { ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }
        },
      },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => 1,
    })
    await Promise.all([core.sayFromGlasses('a'), core.sayFromGlasses('b'), core.sayFromGlasses('c')])
    expect(posts).toEqual([null, '1700000000.000', '1700000000.000'])
    expect(device.of('posted').map(m => m.text)).toEqual(['a', 'b', 'c'])
  })
})

describe('HubCore review fixes', () => {
  const TOKEN = 't'.repeat(40)

  function core(over: Partial<HubDeps> = {}, devices: FakeDevice[] = []) {
    const asr = new FakeAsr()
    const posts: Array<{ text: string; threadTs: string | null }> = []
    let now = 1_000_000
    let n = 0
    const c = new HubCore({
      storage: new FakeStorage(),
      sockets: () => devices,
      deviceToken: TOKEN,
      slack: {
        selfUserId: async () => null,
        postToKid: async (text, threadTs) => {
          posts.push({ text, threadTs })
          return { ts: `9.${n++}`, channel: 'D0123ABCDEF' }
        },
      },
      asr: { connect: async () => asr },
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => now,
      ...over,
    })
    return { c, asr, posts, advance: (ms: number) => (now += ms) }
  }

  it('F1: an unauthenticated socket gets nothing until it sends the token in the first frame', async () => {
    const stranger = new FakeDevice(false)
    const { c } = core({}, [stranger])
    await c.onKidMessage({ eventId: 'E1', channel: 'D0123ABCDEF', user: 'U', text: 'secret news', ts: '1', threadTs: null, botId: null, kind: 'message' as const, verifiedKid: false })
    expect(stranger.sent).toEqual([])
    await c.onDeviceMessage(stranger, JSON.stringify({ t: 'history' }))
    expect(stranger.closed).toEqual({ code: 4401, reason: 'unauthorized' })
    expect(stranger.of('history')).toEqual([])
  })

  it('F1: a wrong token closes the socket; the right token authenticates it', async () => {
    const bad = new FakeDevice(false)
    const good = new FakeDevice(false)
    const { c } = core({}, [bad, good])
    await c.onDeviceMessage(bad, JSON.stringify({ t: 'auth', token: 'wrong' }))
    expect(bad.closed?.code).toBe(4401)
    await c.onDeviceMessage(good, JSON.stringify({ t: 'auth', token: TOKEN }))
    expect(good.of('auth.ok')).toHaveLength(1)
    expect(good.closed).toBeNull()
    await c.onDeviceMessage(good, JSON.stringify({ t: 'ping' }))
    expect(good.of('pong')).toHaveLength(1)
  })

  it('F1: with DEVICE_TOKEN unset every socket is refused', async () => {
    const d = new FakeDevice(false)
    const { c } = core({ deviceToken: undefined }, [d])
    await c.onDeviceMessage(d, JSON.stringify({ t: 'auth', token: '' }))
    expect(d.closed?.code).toBe(4503)
  })

  it('F3: session.new during an in-flight post is not undone by the post finishing', async () => {
    const d = new FakeDevice()
    let release: () => void = () => {}
    const posts: Array<string | null> = []
    const { c } = core(
      {
        slack: {
        selfUserId: async () => null,
          postToKid: async (_t, threadTs) => {
            posts.push(threadTs)
            if (posts.length === 1) await new Promise<void>(r => (release = r))
            return { ts: `9.${posts.length}`, channel: 'D0123ABCDEF' }
          },
        },
      },
      [d],
    )
    const first = c.sayFromGlasses('one')
    await flush()
    const reset = c.onDeviceMessage(d, JSON.stringify({ t: 'session.new' }))
    release()
    await Promise.all([first, reset])
    await c.sayFromGlasses('two')
    expect(posts).toEqual([null, null])
  })

  it('F3: a Kid reply after the session expired does not revive the old thread', async () => {
    const { c, posts, advance } = core({}, [new FakeDevice()])
    await c.sayFromGlasses('one')
    advance(SESSION_IDLE_MS + 1)
    await c.onKidMessage({ eventId: 'E1', channel: 'D0123ABCDEF', user: 'U', text: 'late', ts: '2', threadTs: '9.0', botId: null, kind: 'message' as const, verifiedKid: false })
    await c.sayFromGlasses('two')
    expect(posts.map(p => p.threadTs)).toEqual([null, null])
  })

  it('F4: hello replays every retained message after lastSeq, beyond one page', async () => {
    const d = new FakeDevice()
    const { c } = core({}, [])
    for (let i = 1; i <= 120; i++) await c.onKidMessage({ eventId: `E${i}`, channel: 'D0123ABCDEF', user: 'U', text: `m${i}`, ts: `${i}`, threadTs: null, botId: null, kind: 'message' as const, verifiedKid: false })
    await c.onDeviceMessage(d, JSON.stringify({ t: 'hello', lastSeq: 0 }))
    const seqs = d.of('msg').map(m => m.seq)
    expect(seqs).toHaveLength(120)
    expect(seqs[0]).toBe(1)
    expect(seqs.at(-1)).toBe(120)
  })

  it('F5: a new turn can start while the previous one is still draining', async () => {
    const first = new FakeAsr()
    const second = new FakeAsr()
    const sockets = [first, second]
    const d = new FakeDevice()
    const { c, posts } = core({ asr: { connect: async () => sockets.shift() as FakeAsr } }, [d])
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.start' }))
    first.result('第一句', true)
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.stop' }))
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.start' }))
    const frame = new Uint8Array(8)
    await c.onDeviceMessage(d, frame)
    expect(second.sent).toEqual([frame])
    first.result('', true, { fromFinalize: true })
    await flush()
    second.result('第二句', true)
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.stop' }))
    second.result('', true, { fromFinalize: true })
    await flush()
    expect(posts.map(p => p.text)).toEqual(['〔眼镜〕第一句', '〔眼镜〕第二句'])
  })

  it('F5: an upstream failure is reported and the partial transcript is not posted', async () => {
    const d = new FakeDevice()
    const { c, asr, posts } = core({ asrLimits: { maxReconnects: 0 } }, [d])
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.start' }))
    asr.result('半句', true)
    asr.emit('error', {})
    await flush()
    expect(posts).toEqual([])
    expect(d.of('error').map(m => m.code)).toEqual(['asr-interrupted'])
    const early = new FakeAsr()
    const { c: c2, posts: posts2 } = core({ asr: { connect: async () => early }, asrLimits: { maxReconnects: 0 } }, [d])
    await c2.onDeviceMessage(d, JSON.stringify({ t: 'audio.start' }))
    early.result('没说完', true)
    early.close(1011)
    await flush()
    expect(posts2).toEqual([])
  })
})

describe('HubCore review round 2', () => {
  function core2(over: Partial<HubDeps> = {}) {
    const storage = new FakeStorage()
    const device = new FakeDevice()
    const posts: string[] = []
    const c = new HubCore({
      storage,
      sockets: () => [device],
      slack: {
        selfUserId: async () => 'UFOX0001',
        postToKid: async text => {
          posts.push(text)
          return { ts: `9.${posts.length}`, channel: 'D0123ABCDEF' }
        },
      },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => 1,
      ...over,
    })
    return { c, storage, device, posts }
  }
  const kid = (eventId: string, user = 'UKID0001', text = 'hi') => ({ eventId, channel: 'D0123ABCDEF', user, text, ts: '1', threadTs: null, botId: null, kind: 'message' as const, verifiedKid: false })

  it('F2: history and the seen marker are written together, so a retry after a failed write stores the reply once', async () => {
    const { c, storage } = core2()
    storage.failNextPutAll = true
    await expect(c.onKidMessage(kid('E1'))).rejects.toThrow('storage write failed')
    await c.onKidMessage(kid('E1'))
    await c.onKidMessage(kid('E1'))
    const page = await c.history.page(null, 10)
    expect(page.items.map(i => i.text)).toEqual(['hi'])
  })

  it('R2-1: storing a Kid reply does not wait for an in-flight Slack post', async () => {
    let release: () => void = () => {}
    const { c } = core2({
      slack: {
        selfUserId: async () => 'UFOX0001',
        postToKid: () => new Promise(r => (release = () => r({ ts: '9.1', channel: 'D0123ABCDEF' }))),
      },
    })
    const posting = c.sayFromGlasses('slow')
    await flush()
    const stored = await Promise.race([c.onKidMessage(kid('E2')).then(() => 'stored'), new Promise(r => setTimeout(() => r('blocked'), 20))])
    expect(stored).toBe('stored')
    release()
    await posting
  })

  it("F7: Fox's own message is dropped by the token's own user id, and the 〔眼镜〕 prefix is never shown as Kid", async () => {
    const { c, device } = core2()
    expect(await c.onKidMessage(kid('E3', 'UFOX0001', '〔眼镜〕echo'))).toBeNull()
    expect(await c.onKidMessage(kid('E4', 'UKID0001', 'kid text'))).not.toBeNull()
    expect(await c.onKidMessage(kid('E5', 'UKID0001', '〔眼镜〕echo seen as kid'))).toBeNull()
    expect(device.of('msg').map(m => m.text)).toEqual(['kid text'])
  })

  it('F5: a close other than 1000 after audio.stop is reported and not posted', async () => {
    const asr = new FakeAsr()
    const { c, device, posts } = core2({ asr: { connect: async () => asr }, asrLimits: { maxReconnects: 0 } })
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    asr.result('一半', true)
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    asr.close(1011)
    await c.turnsSettled
    expect(posts).toEqual([])
    expect(device.of('error').map(m => m.code)).toEqual(['asr-interrupted'])
  })

  it('R2-2: transcripts are posted in the order the turns started, even if they finish out of order', async () => {
    const first = new FakeAsr()
    const second = new FakeAsr()
    const queue = [first, second]
    const { c, device, posts } = core2({ asr: { connect: async () => queue.shift() as FakeAsr } })
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    first.result('第一句', true)
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.start' }))
    second.result('第二句', true)
    await c.onDeviceMessage(device, JSON.stringify({ t: 'audio.stop' }))
    second.result('', true, { fromFinalize: true })
    await flush()
    first.result('', true, { fromFinalize: true })
    await c.turnsSettled
    expect(posts).toEqual(['〔眼镜〕第一句', '〔眼镜〕第二句'])
  })
})

describe('HubCore bot-DM model', () => {
  function core3() {
    let now = 1_000_000
    let n = 0
    const device = new FakeDevice()
    const selfUserId = vi.fn(async () => 'UFOX0001')
    const c = new HubCore({
      storage: new FakeStorage(),
      sockets: () => [device],
      slack: {
        selfUserId,
        postToKid: async () => ({ ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }),
      },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => now,
    })
    return { c, device, selfUserId, advance: (ms: number) => (now += ms) }
  }
  const kidMsg = (over: Partial<KidMessage>): KidMessage => ({
    eventId: `E${Math.random()}`,
    channel: 'D0123ABCDEF',
    user: null,
    botId: 'B0KIDBOT01',
    text: 'reply',
    ts: '1700000001.000000',
    threadTs: null,
    kind: 'message',
    verifiedKid: false,
    ...over,
  })

  it('matches an in-thread Kid reply to the session that opened the thread, even after a new session started', async () => {
    const { c, device, advance } = core3()
    await c.sayFromGlasses('first session question')
    const firstSession = device.of('posted').length ? (await c.history.page(null, 1)).items[0].session : null
    advance(SESSION_IDLE_MS + 1)
    await c.sayFromGlasses('second session question')
    const secondSession = (await c.history.page(null, 1)).items[0].session
    expect(firstSession).not.toBe(secondSession)
    await c.onKidMessage(kidMsg({ text: 'answer to first', threadTs: '1700000000.000' }))
    await c.onKidMessage(kidMsg({ text: 'answer to second', threadTs: '1700000000.001' }))
    const msgs = device.of('msg')
    expect(msgs.map(m => [m.text, m.session])).toEqual([
      ['answer to first', firstSession],
      ['answer to second', secondSession],
    ])
  })

  it('assigns a top-level Kid reply to the active session, or to none once it has expired', async () => {
    const { c, device, advance } = core3()
    await c.sayFromGlasses('q')
    const active = (await c.history.page(null, 1)).items[0].session
    await c.onKidMessage(kidMsg({ text: 'top-level now' }))
    advance(SESSION_IDLE_MS + 1)
    await c.onKidMessage(kidMsg({ text: 'top-level later' }))
    expect(device.of('msg').map(m => [m.text, m.session])).toEqual([
      ['top-level now', active],
      ['top-level later', null],
    ])
  })

  it('marks an edited Kid reply and appends it rather than rewriting history', async () => {
    const { c, device } = core3()
    await c.onKidMessage(kidMsg({ eventId: 'E1', text: '三点放学' }))
    await c.onKidMessage(kidMsg({ eventId: 'E2', text: '三点半放学', kind: 'edit' }))
    expect(device.of('msg').map(m => [m.text, m.edited ?? false])).toEqual([
      ['三点放学', false],
      ['（已修改）三点半放学', true],
    ])
  })

  it('does not call auth.test for bot messages without a user, and drops Fox by the resolved id', async () => {
    const { c, device, selfUserId } = core3()
    await c.onKidMessage(kidMsg({ eventId: 'E1', user: null }))
    expect(selfUserId).not.toHaveBeenCalled()
    await c.onKidMessage(kidMsg({ eventId: 'E2', user: 'UFOX0001', botId: null, text: 'typed by Fox' }))
    expect(selfUserId).toHaveBeenCalledOnce()
    expect(device.of('msg').map(m => m.text)).toEqual(['reply'])
  })
})

describe('HubCore kid sender logging', () => {
  it('logs each new Kid sender id pair once, without message text', async () => {
    const logs: string[] = []
    const c = new HubCore({
      storage: new FakeStorage(),
      sockets: () => [],
      slack: { selfUserId: async () => 'UFOX0001', postToKid: async () => ({ ts: '1', channel: 'D0123ABCDEF' }) },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => 1,
      log: m => logs.push(m),
    })
    const m = (eventId: string, text: string) => ({ eventId, channel: 'D0123ABCDEF', user: 'U0KIDBOT01', botId: 'B0KIDBOT01', text, ts: '1', threadTs: null, kind: 'message' as const, verifiedKid: false })
    await c.onKidMessage(m('E1', 'secret homework answer'))
    await c.onKidMessage(m('E2', 'second'))
    expect(logs).toEqual(['kid sender user=U0KIDBOT01 bot=B0KIDBOT01'])
  })
})

describe('HubCore bot-DM review fixes', () => {
  function core4(selfUserId: () => Promise<string | null> = async () => 'UFOX0001') {
    let now = 1_000_000
    let n = 0
    const device = new FakeDevice()
    const c = new HubCore({
      storage: new FakeStorage(),
      sockets: () => [device],
      slack: { selfUserId, postToKid: async () => ({ ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }) },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      now: () => now,
    })
    return { c, device, advance: (ms: number) => (now += ms) }
  }
  const km = (over: Partial<KidMessage>): KidMessage => ({
    eventId: 'E0', channel: 'D0123ABCDEF', user: null, botId: 'B0KIDBOT01', text: 'r', ts: '1700000009.000000', threadTs: null, kind: 'message', verifiedKid: false, ...over,
  })

  it('F1: a verified Kid reply starting with 〔眼镜〕 reaches the glasses; an unverified one does not', async () => {
    const { c, device } = core4()
    await c.onKidMessage(km({ eventId: 'E1', text: '〔眼镜〕unverified' }))
    await c.onKidMessage(km({ eventId: 'E2', text: '〔眼镜〕verified', verifiedKid: true }))
    expect(device.of('msg').map(m => m.text)).toEqual(['〔眼镜〕verified'])
  })

  it('F2: an edit whose delivered text did not change is not appended again (no previous_message case)', async () => {
    const { c, device } = core4()
    await c.onKidMessage(km({ eventId: 'E1', text: '三点', ts: '5.1' }))
    await c.onKidMessage(km({ eventId: 'E2', text: '三点', ts: '5.1', kind: 'edit' }))
    await c.onKidMessage(km({ eventId: 'E3', text: '三点半', ts: '5.1', kind: 'edit' }))
    await c.onKidMessage(km({ eventId: 'E4', text: '三点半', ts: '5.1', kind: 'edit' }))
    expect(device.of('msg').map(m => m.text)).toEqual(['三点', '（已修改）三点半'])
  })

  it('F3: a reply in an old session thread does not extend the active session', async () => {
    const { c, device, advance } = core4()
    await c.sayFromGlasses('A')
    advance(SESSION_IDLE_MS + 1)
    await c.sayFromGlasses('B')
    const b = (await c.history.page(null, 1)).items[0].session
    advance(SESSION_IDLE_MS - 1000)
    await c.onKidMessage(km({ eventId: 'E1', text: 'late answer to A', threadTs: '1700000000.000' }))
    advance(2000)
    await c.onKidMessage(km({ eventId: 'E2', text: 'top-level after B expired' }))
    const msgs = device.of('msg').map(m => [m.text, m.session])
    expect(msgs[0][1]).not.toBe(b)
    expect(msgs[1]).toEqual(['top-level after B expired', null])
  })

  it('F4: a Slack retry arriving while auth.test is pending is delivered once', async () => {
    let release: (v: string) => void = () => {}
    const pending = new Promise<string>(r => (release = r))
    const { c, device } = core4(() => pending)
    const first = c.onKidMessage(km({ eventId: 'E9', user: 'U0KIDBOT01', text: 'edited', kind: 'edit' }))
    const retry = c.onKidMessage(km({ eventId: 'E9', user: 'U0KIDBOT01', text: 'edited', kind: 'edit' }))
    await flush()
    release('UFOX0001')
    await Promise.all([first, retry])
    expect(device.of('msg')).toHaveLength(1)
  })
})


describe('HubCore Kid webhook', () => {
  function core5(hook: KidWebhook | null, opts: { failPost?: boolean } = {}) {
    let now = 1_000_000
    let n = 0
    const device = new FakeDevice()
    const logs: string[] = []
    const c = new HubCore({
      storage: new FakeStorage(),
      sockets: () => [device],
      slack: {
        selfUserId: async () => 'UFOX0001',
        postToKid: async () => {
          if (opts.failPost) throw new ChannelNotAllowedError()
          return { ts: `1700000000.00${n++}`, channel: 'D0123ABCDEF' }
        },
      },
      asr: null,
      timers: new FakeTimers(),
      fastLane: DISABLED_FAST_LANE,
      kidWebhook: hook,
      now: () => now,
      log: m => logs.push(m),
    })
    return { c, device, logs, advance: (ms: number) => (now += ms) }
  }
  const recordingHook = (result: KidWebhookResult = { ok: true, status: 200, attempts: 1 }) => {
    const payloads: KidWebhookPayload[] = []
    return { payloads, hook: { notify: async (p: KidWebhookPayload) => (payloads.push(p), result) } }
  }

  it('sends the transcript without the 〔眼镜〕 prefix; thread_ts stays for the session while message_ts is new', async () => {
    const { payloads, hook } = recordingHook()
    const { c, device, advance } = core5(hook)
    await c.sayFromGlasses('今天 几点放学 <b>&')
    advance(1000)
    await c.sayFromGlasses('还有作业吗')
    advance(SESSION_IDLE_MS + 1)
    await c.sayFromGlasses('新会话')
    expect(payloads.map(p => [p.thread_ts, p.message_ts, p.text])).toEqual([
      ['1700000000.000', '1700000000.000', '今天 几点放学 <b>&'],
      ['1700000000.000', '1700000000.001', '还有作业吗'],
      ['1700000000.002', '1700000000.002', '新会话'],
    ])
    expect(payloads[0]).toMatchObject({ v: 1, source: 'kid-glasses', channel: 'D0123ABCDEF', at: 1_000_000 })
    expect(payloads[0].session).toBe(payloads[1].session)
    expect(payloads[2].session).not.toBe(payloads[0].session)
    expect(payloads.every(p => !p.text.includes('〔眼镜〕'))).toBe(true)
    expect(device.of('kid-webhook').map(m => m.result)).toEqual(['ok', 'ok', 'ok'])
  })

  it('a webhook failure keeps the Slack post and history, and tells the device without leaking config', async () => {
    const { hook } = recordingHook({ ok: false, status: 502, attempts: 2 })
    const { c, device, logs } = core5(hook)
    const item = await c.sayFromGlasses('hi')
    expect(item).not.toBeNull()
    expect(device.of('posted')).toHaveLength(1)
    expect(device.of('kid-webhook')).toEqual([{ t: 'kid-webhook', seq: 1, result: 'failed', status: 502 }])
    expect(device.of('error')).toEqual([{ t: 'error', code: 'kid-webhook-failed', message: 'kid webhook failed (502)' }])
    expect(logs.join('\n')).not.toMatch(/https?:|example/)
  })

  it('a throwing webhook is treated as a network failure, not a crash', async () => {
    const { c, device } = core5({ notify: async () => { throw new Error('boom https://secret.example') } })
    expect(await c.sayFromGlasses('hi')).not.toBeNull()
    expect(device.of('error')).toEqual([{ t: 'error', code: 'kid-webhook-failed', message: 'kid webhook failed (network)' }])
  })

  it('without a webhook, keeps post-only behaviour and reports skipped', async () => {
    const { c, device } = core5(null)
    expect(await c.sayFromGlasses('hi')).not.toBeNull()
    expect(device.of('kid-webhook')).toEqual([{ t: 'kid-webhook', seq: 1, result: 'skipped', status: null }])
    expect(device.of('error')).toEqual([])
  })

  it('does not call the webhook when the Slack post fails', async () => {
    const { payloads, hook } = recordingHook()
    const { c } = core5(hook, { failPost: true })
    expect(await c.sayFromGlasses('hi')).toBeNull()
    expect(payloads).toEqual([])
  })
})
