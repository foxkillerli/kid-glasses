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
      voiceTailMs: 30,
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
    expect(body()).toMatch(/Kid：/)
    expect(body()).not.toContain('Kid：三点半放学，我来接你')
    const send0 = (ev: Record<string, unknown>) => (app as unknown as { onEvent(e: unknown): void }).onEvent(ev)
    send0({ sysEvent: { eventType: 0 } })
    await settle()
    expect(body()).toContain('Kid：三点半放学，我来接你')
    expect(ws.json().some(m => m.t === 'audio.start')).toBe(false)

    const send = (ev: Record<string, unknown>) => (app as unknown as { onEvent(e: unknown): void }).onEvent(ev)
    const audio = (jsonData: Record<string, unknown>) => evenHubEventFromJson({ type: 'audioEvent', jsonData })
    send({ sysEvent: { eventType: 9 } })
    await settle()
    const start = ws.json().find(m => m.t === 'audio.start')
    expect(start?.cid).toBeTruthy()
    expect(start?.lang).toBe('auto')
    send(audio({ audioPcm: [1, 0, 2, 0], source: 'glasses' }))
    send(audio({ audioPcm: [9, 9], source: 'phone' }))
    send(audio({ audioPcm: [8, 8], audioSource: 'phone' }))
    send(audio({ audioPcm: [3, 0] }))
    ws.frame({ t: 'asr.partial', text: '今天几点', cid: start?.cid })
    await settle()
    expect(body()).toContain('你说：今天几点')
    send({ sysEvent: { eventType: 10 } })
    await settle()
    send(audio({ audioPcm: [5, 0] }))
    expect(ws.json().some(m => m.t === 'audio.stop')).toBe(false)
    expect(body()).toContain('你说：今天几点')
    await new Promise(r => setTimeout(r, 60))
    await settle()
    expect(ws.json().some(m => m.t === 'audio.stop')).toBe(true)
    send(audio({ audioPcm: [6, 0] }))
    ws.frame({ t: 'asr.final', text: '今天几点放学', cid: start?.cid })
    await settle()
    expect(body()).toContain('你说：今天几点放学')
    ws.frame({ t: 'msg', seq: 4, from: 'glasses', text: '今天几点放学', at: 3, session: 's', cid: start?.cid })
    await settle()
    expect(body()).not.toContain('你说：')
    expect(body()).toContain('我：今天几点放学')
    const binary = ws.sent.filter(d => typeof d !== 'string') as Uint8Array[]
    expect(binary.map(b => Array.from(b))).toEqual([
      [1, 0, 2, 0],
      [3, 0],
      [5, 0],
    ])
    expect(ws.json().filter(m => String(m.t).startsWith('audio')).map(m => m.t)).toEqual(['audio.start', 'audio.stop'])
    expect(audioControl.mock.calls).toEqual([
      [true, 'glasses'],
      [false, 'glasses'],
    ])
    expect(fetchCalls.every(u => u.startsWith('https://kid-glasses-relay.your-subdomain.workers.dev/pair/'))).toBe(true)
  })

  it('the menu language toggle is saved, shown and sent with audio.start; after release the hint says 正在转写', async () => {
    const { App } = await import('../src/app')
    const bridge = {
      audioControl: vi.fn(async () => true),
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
    store.map.set(STORE_KEYS.token, 'kgd_saved')
    store.map.set(STORE_KEYS.asrLang, 'en')
    const sockets: FakeWs[] = []
    const app = new App(bridge, { render() {} }, null, {
      store,
      fetch: vi.fn(async () => Response.json({})),
      ws: (url, protocols) => {
        const ws = new FakeWs(url, protocols)
        sockets.push(ws)
        return ws
      },
      voiceTailMs: 0,
    })
    const a = app as unknown as { bodyText(): string; statusLine(): string; hintText(): string; onEvent(e: unknown): void }
    await app.start()
    await settle()
    const ws = sockets[0]
    ws.open()
    ws.frame({ t: 'auth.ok' })
    await settle()
    expect(a.statusLine()).toContain('EN')
    expect(a.bodyText()).toContain('识别语言：English')
    a.onEvent({ sysEvent: { eventType: 3 } })
    a.onEvent({ textEvent: { eventType: 2 } })
    expect(a.bodyText()).toContain('> 2. 语言：English')
    a.onEvent({ sysEvent: { eventType: 0 } })
    a.onEvent({ sysEvent: { eventType: 0 } })
    await settle()
    expect(a.bodyText()).toContain('语言：中文')
    expect(store.map.get(STORE_KEYS.asrLang)).toBe('zh')
    a.onEvent({ textEvent: { eventType: 1 } })
    a.onEvent({ sysEvent: { eventType: 0 } })
    expect(a.statusLine()).toContain('中文')
    a.onEvent({ sysEvent: { eventType: 9 } })
    await settle()
    const start = ws.json().find(m => m.t === 'audio.start')
    expect(start?.lang).toBe('zh')
    expect(a.hintText()).toContain('正在听')
    ws.frame({ t: 'error', code: 'asr-no-audio', message: 'x', cid: start?.cid })
    await settle()
    expect(a.hintText()).toContain('眼镜的声音断了')
    a.onEvent({ sysEvent: { eventType: 9 } })
    await settle()
    expect(a.hintText()).toContain('正在听')
    a.onEvent(evenHubEventFromJson({ type: 'audioEvent', jsonData: { audioPcm: [1, 0] } }))
    a.onEvent({ sysEvent: { eventType: 10 } })
    await settle()
    expect(ws.json().filter(m => m.t === 'audio.stop')).toHaveLength(1)
    expect(a.hintText()).toContain('… 正在转写')
  })

  it('review M2-2/M2-5: audio.stop is sent even if the mic close never answers, and transcripts of another turn are ignored', async () => {
    const { App } = await import('../src/app')
    const bridge = {
      audioControl: vi.fn(async (open: boolean) => (open ? true : new Promise(() => {}))),
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
    store.map.set(STORE_KEYS.token, 'kgd_saved')
    const sockets: FakeWs[] = []
    const app = new App(bridge, { render() {} }, null, {
      store,
      fetch: vi.fn(async () => Response.json({})),
      ws: (url, protocols) => {
        const ws = new FakeWs(url, protocols)
        sockets.push(ws)
        return ws
      },
      voiceTailMs: 0,
      micCloseWaitMs: 20,
    })
    const a = app as unknown as { bodyText(): string; onEvent(e: unknown): void }
    await app.start()
    await settle()
    const ws = sockets[0]
    ws.open()
    ws.frame({ t: 'auth.ok' })
    a.onEvent({ sysEvent: { eventType: 9 } })
    await settle()
    const start = ws.json().find(m => m.t === 'audio.start')
    ws.frame({ t: 'asr.partial', text: '这是我的', cid: start?.cid })
    ws.frame({ t: 'asr.partial', text: '别的回合', cid: 'other-turn-123' })
    await settle()
    expect(a.bodyText()).toContain('你说：这是我的')
    expect(a.bodyText()).not.toContain('别的回合')
    a.onEvent(evenHubEventFromJson({ type: 'audioEvent', jsonData: { audioPcm: [1, 0] } }))
    a.onEvent({ sysEvent: { eventType: 10 } })
    await settle()
    expect(ws.json().some(m => m.t === 'audio.stop')).toBe(false)
    await new Promise(r => setTimeout(r, 40))
    await settle()
    expect(ws.json().filter(m => m.t === 'audio.stop')).toHaveLength(1)
    ws.frame({ t: 'asr.final', text: '', cid: 'other-turn-123' })
    await settle()
    expect(a.bodyText()).toContain('你说：这是我的')
  })

  it.each([
    ['online', false],
    ['offline', true],
  ])('the post-release wait has an online-only deadline (%s)', async (_label, offline) => {
    const { App } = await import('../src/app')
    const bridge = {
      audioControl: vi.fn(async () => true),
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
    store.map.set(STORE_KEYS.token, 'kgd_saved')
    const sockets: FakeWs[] = []
    const app = new App(bridge, { render() {} }, null, {
      store,
      fetch: vi.fn(async () => Response.json({})),
      ws: (url, protocols) => {
        const ws = new FakeWs(url, protocols)
        sockets.push(ws)
        return ws
      },
      voiceTailMs: 0,
      liveWaitMs: 20,
    })
    const a = app as unknown as { bodyText(): string; hintText(): string; onEvent(e: unknown): void; checkLiveWait(): void }
    await app.start()
    await settle()
    const ws = sockets[0]
    ws.open()
    ws.frame({ t: 'auth.ok' })
    a.onEvent({ sysEvent: { eventType: 9 } })
    await settle()
    const start = ws.json().find(m => m.t === 'audio.start')
    ws.frame({ t: 'asr.partial', text: '等不到', cid: start?.cid })
    a.onEvent(evenHubEventFromJson({ type: 'audioEvent', jsonData: { audioPcm: [1, 0] } }))
    a.onEvent({ sysEvent: { eventType: 10 } })
    await settle()
    a.checkLiveWait()
    expect(a.hintText()).toContain('正在转写')
    if (offline) {
      ws.drop()
      await settle()
    }
    await new Promise(r => setTimeout(r, 40))
    a.checkLiveWait()
    if (offline) {
      expect(a.bodyText()).toContain('你说：等不到')
      return
    }
    expect(a.bodyText()).not.toContain('你说：')
    expect(a.hintText()).toContain('转写超时')
  })

  it('M3-5: 新对话 sends session.new from the menu; the hint says when newer content is below; a scheduled resend shows 重发; the phone-page log holds no transcript, Kid text, token or cid', async () => {
    const { App } = await import('../src/app')
    const bridge = {
      audioControl: vi.fn(async () => true),
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
    store.map.set(STORE_KEYS.token, 'kgd_secret_token_value')
    const sockets: FakeWs[] = []
    const app = new App(bridge, { render() {} }, null, {
      store,
      fetch: vi.fn(async () => Response.json({})),
      ws: (url, protocols) => {
        const ws = new FakeWs(url, protocols)
        sockets.push(ws)
        return ws
      },
      voiceTailMs: 0,
    })
    const a = app as unknown as { bodyText(): string; hintText(): string; statusLine(): string; onEvent(e: unknown): void; log: { last(n: number): Array<{ m: string }> } }
    await app.start()
    await settle()
    const ws = sockets[0]
    ws.open()
    ws.frame({ t: 'auth.ok' })
    a.onEvent({ sysEvent: { eventType: 3 } })
    a.onEvent({ textEvent: { eventType: 2 } })
    a.onEvent({ textEvent: { eventType: 2 } })
    expect(a.bodyText()).toContain('> 3. 新对话')
    a.onEvent({ sysEvent: { eventType: 0 } })
    expect(ws.json().filter(m => m.t === 'session.new')).toHaveLength(1)
    expect(a.hintText()).toContain('已开始新对话')
    expect((app as unknown as { screen: { kind: string } }).screen.kind).toBe('kid')
    const long = 'Kid的长回复SECRETKIDTEXT'.repeat(40)
    ws.frame({ t: 'msg', seq: 1, from: 'kid', text: long, at: 1, session: 's1' })
    await settle()
    a.onEvent({ sysEvent: { eventType: 0 } })
    await settle()
    ;(app as unknown as { flash: unknown }).flash = null
    expect(a.hintText()).toMatch(/↓ 下面还有 下滑查看 1\/\d/)
    for (let i = 0; i < 5; i++) a.onEvent({ textEvent: { eventType: 2 } })
    expect(a.hintText()).not.toContain('↓')
    a.onEvent({ textEvent: { eventType: 1 } })
    expect(a.hintText()).toContain('↓ 下面还有')
    ws.frame({ t: 'turn.pending', cid: 'voice-cid-0009', text: '我说的秘密SECRETVOICETEXT' })
    ws.frame({ t: 'error', code: 'slack-unreachable', message: 'x', cid: 'voice-cid-0009' })
    await settle()
    expect(a.statusLine()).toContain('重发1')
    ws.drop()
    await settle()
    expect(a.statusLine()).toContain('待发1')
    const log = a.log.last(400).map(e => e.m).join('\n')
    for (const leak of ['SECRETKIDTEXT', 'SECRETVOICETEXT', 'kgd_secret_token_value', 'voice-cid-0009']) expect(log, leak).not.toContain(leak)
  })
})
