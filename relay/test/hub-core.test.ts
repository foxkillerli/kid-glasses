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
