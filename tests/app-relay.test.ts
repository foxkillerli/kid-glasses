import { beforeAll, describe, expect, it, vi } from 'vitest'
import { evenHubEventFromJson, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { MemoryStore } from '../src/lib/store'
import { STORE_KEYS } from '../src/lib/relay-config'
import type { Layout } from '../src/lib/display'
import { FakeWs, tick } from './relay-fakes'

beforeAll(() => {
  const g = globalThis as Record<string, unknown>
  g.window = g.window ?? globalThis
  const w = g.window as Record<string, unknown>
  w.location = { protocol: 'http:', host: 'localhost', hostname: 'localhost' }
  w.addEventListener = w.addEventListener ?? (() => {})
  g.document = g.document ?? { visibilityState: 'visible', addEventListener() {} }
  g.WebSocket = class {
    readyState = 0
    onopen = null
    onmessage = null
    onclose = null
    onerror = null
    send() {}
    close() {}
  }
})

const settle = async () => {
  for (let i = 0; i < 10; i++) await tick()
}

describe('App M1 flow (fake bridge, fake relay)', () => {
  it('pairs via the lens code, connects with the minted token, shows Kid replies, and streams only glasses audio', async () => {
    const { App } = await import('../src/app')
    const audioControl = vi.fn(async (_open: boolean, _source?: string) => true)
    const bridge = {
      audioControl,
      createStartUpPageContainer: vi.fn(async () => 0),
      rebuildPageContainer: vi.fn(async () => true),
      textContainerUpgrade: vi.fn(async () => true),
      shutDownPageContainer: vi.fn(async () => true),
      onEvenHubEvent: vi.fn(),
      onLaunchSource: vi.fn(),
      onDeviceStatusChanged: vi.fn(),
      getDeviceInfo: vi.fn(async () => null),
    } as unknown as EvenAppBridge
    const store = new MemoryStore()
    const sockets: FakeWs[] = []
    const fetchCalls: string[] = []
    const fetchFn = vi.fn(async (url: string) => {
      fetchCalls.push(url)
      if (url.endsWith('/pair/start')) return Response.json({ pairId: 'f'.repeat(32), code: '246810', expiresAt: Date.now() + 300_000 })
      return Response.json({ status: 'paired', token: 'kgd_minted', deviceId: 'dev1' })
    })
    let lastLayout: Layout | null = null
    const app = new App(bridge, { render: l => void (lastLayout = l ?? lastLayout) }, null, {
      store,
      fetch: fetchFn,
      ws: (url, protocols) => {
        const ws = new FakeWs(url, protocols)
        sockets.push(ws)
        return ws
      },
    })
    const body = () => (app as unknown as { bodyText(): string }).bodyText()
    await app.start()
    await settle()
    expect(body()).toContain('配对码：246810')
    expect(body()).toContain('配对 246810')
    expect(lastLayout).not.toBeNull()

    await (app as unknown as { pairing: { poll(): Promise<void> } }).pairing.poll()
    await settle()
    expect(store.map.get(STORE_KEYS.token)).toBe('kgd_minted')
    expect(sockets).toHaveLength(1)
    const ws = sockets[0]
    expect(ws.url).toBe('wss://kid-glasses-relay.your-subdomain.workers.dev/device')
    ws.open()
    expect(ws.json()[0]).toEqual({ t: 'auth', token: 'kgd_minted' })
    ws.frame({ t: 'auth.ok' })
    ws.frame({ t: 'msg', seq: 3, from: 'kid', text: '三点半放学，我来接你', at: 1, session: 's1' })
    await settle()
    expect(body()).toContain('Kid：三点半放学，我来接你')

    const send = (ev: Record<string, unknown>) => (app as unknown as { onEvent(e: unknown): void }).onEvent(ev)
    const audio = (jsonData: Record<string, unknown>) => evenHubEventFromJson({ type: 'audioEvent', jsonData })
    send({ sysEvent: { eventType: 9 } })
    await settle()
    const start = ws.json().find(m => m.t === 'audio.start')
    expect(start?.cid).toBeTruthy()
    send(audio({ audioPcm: [1, 0, 2, 0], source: 'glasses' }))
    send(audio({ audioPcm: [9, 9], source: 'phone' }))
    send(audio({ audioPcm: [8, 8], audioSource: 'phone' }))
    send(audio({ audioPcm: [3, 0] }))
    send({ sysEvent: { eventType: 10 } })
    await settle()
    const binary = ws.sent.filter(d => typeof d !== 'string') as Uint8Array[]
    expect(binary.map(b => Array.from(b))).toEqual([
      [1, 0, 2, 0],
      [3, 0],
    ])
    expect(ws.json().filter(m => String(m.t).startsWith('audio')).map(m => m.t)).toEqual(['audio.start', 'audio.stop'])
    expect(audioControl.mock.calls).toEqual([
      [true, 'glasses'],
      [false, 'glasses'],
    ])
    expect(fetchCalls.every(u => u.startsWith('https://kid-glasses-relay.your-subdomain.workers.dev/pair/'))).toBe(true)
  })
})
