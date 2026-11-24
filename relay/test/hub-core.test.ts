import { describe, expect, it, vi } from 'vitest'
import { DISABLED_FAST_LANE, type FastLane } from '../src/fast-lane'
import { HubCore, SESSION_IDLE_MS, type HubDeps } from '../src/hub-core'
import { CLOSE_STREAM } from '../src/deepgram'
import { ChannelNotAllowedError } from '../src/slack-client'
import { FakeAsr, FakeDevice, FakeStorage, flush } from './fakes'

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
    const msg = { eventId: 'Ev1', channel: 'D0123ABCDEF', user: 'UKID', text: '*三点半* 放学 :smile:', ts: '1.2', threadTs: null }
    await core.onKidMessage(msg)
    await core.onKidMessage(msg)
    expect(device.of('msg')).toEqual([{ t: 'msg', seq: 1, from: 'kid', text: '三点半 放学', at: 1_000_000 }])
    await core.onDeviceMessage(device, JSON.stringify({ t: 'history', limit: 10 }))
    expect(device.of('history')[0]).toMatchObject({ more: false, items: [{ seq: 1, from: 'kid', text: '三点半 放学' }] })
  })

  it('replays missed messages after hello with lastSeq', async () => {
    const { core, device } = setup()
    for (const id of ['E1', 'E2', 'E3']) await core.onKidMessage({ eventId: id, channel: 'D0123ABCDEF', user: 'U', text: id, ts: id, threadTs: null })
    await core.onDeviceMessage(device, JSON.stringify({ t: 'hello', lastSeq: 1 }))
    expect(device.of('hello')[0]).toMatchObject({ lastSeq: 3, fastLane: false })
    expect(device.of('msg').slice(-2).map(m => m.text)).toEqual(['E2', 'E3'])
  })

  it('reports Slack refusals to the device instead of posting', async () => {
    const { core, device } = setup({
      slack: {
        selfUserId: async () => null,
        postToKid: async () => {
          throw new ChannelNotAllowedError('C123')
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
    expect(asr.sent.at(-1)).toBe(CLOSE_STREAM)
    await core.onDeviceMessage(device, new Uint8Array(10))
    expect(asr.sent).toHaveLength(2)
    asr.close()
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
    expect(asr.sent).toEqual([new Uint8Array(4), CLOSE_STREAM])
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
      fastLane: DISABLED_FAST_LANE,
      now: () => now,
      ...over,
    })
    return { c, asr, posts, advance: (ms: number) => (now += ms) }
  }

  it('F1: an unauthenticated socket gets nothing until it sends the token in the first frame', async () => {
    const stranger = new FakeDevice(false)
    const { c } = core({}, [stranger])
    await c.onKidMessage({ eventId: 'E1', channel: 'D0123ABCDEF', user: 'U', text: 'secret news', ts: '1', threadTs: null })
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
    await c.onKidMessage({ eventId: 'E1', channel: 'D0123ABCDEF', user: 'U', text: 'late', ts: '2', threadTs: '9.0' })
    await c.sayFromGlasses('two')
    expect(posts.map(p => p.threadTs)).toEqual([null, null])
  })

  it('F4: hello replays every retained message after lastSeq, beyond one page', async () => {
    const d = new FakeDevice()
    const { c } = core({}, [])
    for (let i = 1; i <= 120; i++) await c.onKidMessage({ eventId: `E${i}`, channel: 'D0123ABCDEF', user: 'U', text: `m${i}`, ts: `${i}`, threadTs: null })
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
    first.close(1000)
    await flush()
    second.result('第二句', true)
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.stop' }))
    second.close(1000)
    await flush()
    expect(posts.map(p => p.text)).toEqual(['〔眼镜〕第一句', '〔眼镜〕第二句'])
  })

  it('F5: an upstream failure is reported and the partial transcript is not posted', async () => {
    const d = new FakeDevice()
    const { c, asr, posts } = core({}, [d])
    await c.onDeviceMessage(d, JSON.stringify({ t: 'audio.start' }))
    asr.result('半句', true)
    asr.emit('error', {})
    await flush()
    expect(posts).toEqual([])
    expect(d.of('error').map(m => m.code)).toEqual(['asr-interrupted'])
    const early = new FakeAsr()
    const { c: c2, posts: posts2 } = core({ asr: { connect: async () => early } }, [d])
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
      fastLane: DISABLED_FAST_LANE,
      now: () => 1,
      ...over,
    })
    return { c, storage, device, posts }
  }
  const kid = (eventId: string, user = 'UKID0001', text = 'hi') => ({ eventId, channel: 'D0123ABCDEF', user, text, ts: '1', threadTs: null })

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

  it("F7: Fox's own message is dropped by the token's own user id, whatever the authorizations say", async () => {
    const { c, device } = core2()
    expect(await c.onKidMessage(kid('E3', 'UFOX0001', '〔眼镜〕echo'))).toBeNull()
    expect(await c.onKidMessage(kid('E4', 'UKID0001', '〔眼镜〕kid text'))).not.toBeNull()
    expect(device.of('msg').map(m => m.text)).toEqual(['〔眼镜〕kid text'])
  })

  it('F5: a close other than 1000 after audio.stop is reported and not posted', async () => {
    const asr = new FakeAsr()
    const { c, device, posts } = core2({ asr: { connect: async () => asr } })
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
    second.close(1000)
    await flush()
    first.close(1000)
    await c.turnsSettled
    expect(posts).toEqual(['〔眼镜〕第一句', '〔眼镜〕第二句'])
  })
})
