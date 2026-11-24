import { beforeAll, describe, expect, it, vi } from 'vitest'
import { evenHubEventFromJson, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { checkFrameSource } from '../src/lib/mic-control'

const flush = () => new Promise(r => setTimeout(r, 0))

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.window = g.window ?? globalThis
  ;(g.window as Record<string, unknown>).location = { protocol: 'http:', host: 'localhost', hostname: 'localhost' }
  g.document = g.document ?? { visibilityState: 'visible', addEventListener() {} }
})

function audio(jsonData: Record<string, unknown>) {
  return evenHubEventFromJson({ type: 'audioEvent', jsonData })
}

describe('checkFrameSource', () => {
  it('accepts frames labelled glasses, and unlabelled frames the SDK resolves to glasses', () => {
    expect(checkFrameSource('glasses', { audioPcm: [], source: 'glasses' })).toEqual({ accept: true, hostLabel: 'glasses' })
    expect(checkFrameSource('glasses', { audioPcm: [] })).toEqual({ accept: true, hostLabel: 'absent' })
  })

  it('rejects anything the host or SDK labels as not glasses', () => {
    expect(checkFrameSource('phone', { source: 'phone' })).toMatchObject({ accept: false })
    expect(checkFrameSource('glasses', { audioSource: 'phone' })).toEqual({ accept: false, reason: 'host-audioSource:phone' })
    expect(checkFrameSource('glasses', { source: 'xyz' })).toEqual({ accept: false, reason: 'host-source:xyz' })
    expect(checkFrameSource('phone', {})).toEqual({ accept: false, reason: 'sdk-source:phone' })
    expect(checkFrameSource('glasses', { source: 1 })).toMatchObject({ accept: false })
    expect(checkFrameSource('glasses', { source: 'glasses', audioSource: 'phone' })).toEqual({ accept: false, reason: 'host-audioSource:phone' })
    expect(checkFrameSource('glasses', { audioSource: 'glasses', source: 'phone' })).toEqual({ accept: false, reason: 'host-source:phone' })
    expect(checkFrameSource('glasses', { source: 'glasses', inputSource: 'glasses' })).toEqual({ accept: true, hostLabel: 'glasses' })
  })
})

describe('App mic path end to end (fake bridge, real SDK event parsing)', () => {
  it('only ever requests the glasses mic and never records frames labelled as another source', async () => {
    const { App } = await import('../src/app')
    const audioControl = vi.fn(async (_open: boolean, _source?: string) => true)
    const bridge = {
      audioControl,
      createStartUpPageContainer: vi.fn(async () => 0),
      rebuildPageContainer: vi.fn(async () => true),
      textContainerUpgrade: vi.fn(async () => true),
      shutDownPageContainer: vi.fn(async () => true),
    } as unknown as EvenAppBridge
    const app = new App(bridge, { render() {} }, null)
    const send = (ev: Record<string, unknown>) => (app as unknown as { onEvent(e: unknown): void }).onEvent(ev)

    send({ textEvent: { eventType: 2 } })
    send({ textEvent: { eventType: 2 } })
    send({ sysEvent: {} })
    send({ sysEvent: { eventType: 9 } })
    await flush()

    send(audio({ audioPcm: [1, 0, 2, 0], source: 'glasses' }))
    send(audio({ audioPcm: [3, 0] }))
    send(audio({ audioPcm: [9, 9, 9, 9], source: 'phone' }))
    send(audio({ audioPcm: [8, 8], audioSource: 'phone' }))
    send(audio({ audioPcm: [7, 7], source: 'mystery' }))
    send(audio({ audioPcm: [6, 0], source: 'glasses', audioSource: 'phone' }))

    send({ sysEvent: { eventType: 4 } })
    await flush()
    send({ sysEvent: { eventType: 10 } })
    await flush()

    expect(audioControl.mock.calls).toEqual([
      [true, 'glasses'],
      [true, 'glasses'],
      [false, 'glasses'],
    ])
    expect(Array.from(app.lastClipSamples() ?? [])).toEqual([1, 2, 3])
    const mic = (app as unknown as { mic: { dropped: number; lastDropReason: string } }).mic
    expect(mic.dropped).toBe(4)
    expect(mic.lastDropReason).toBe('host-audioSource:phone')
  })
})
