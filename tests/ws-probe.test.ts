import { afterEach, describe, expect, it, vi } from 'vitest'
import { WsProbe } from '../src/lib/ws-probe'

class FakeSocket {
  static last: FakeSocket
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor() {
    FakeSocket.last = this
  }
  send(s: string) {
    this.sent.push(s)
  }
  close() {}
  open() {
    this.readyState = 1
    this.onopen?.()
  }
}

afterEach(() => vi.useRealTimers())

describe('WsProbe', () => {
  it('pings on open, matches echoed pongs by id, ignores the greeting, and reconnects after close', () => {
    vi.useFakeTimers()
    let now = 1000
    const logs: string[] = []
    const probe = new WsProbe({
      url: 'wss://example.test/echo',
      pingEveryMs: 5000,
      reconnectMs: 3000,
      now: () => now,
      log: m => logs.push(m),
      makeSocket: () => new FakeSocket() as unknown as WebSocket,
    })
    probe.start()
    const ws = FakeSocket.last
    ws.open()
    expect(probe.stats.state).toBe('open')
    expect(ws.sent).toHaveLength(1)
    ws.onmessage?.({ data: 'kid-glasses echo ready' })
    now = 1023
    ws.onmessage?.({ data: ws.sent[0] })
    expect(probe.stats.pongs).toBe(1)
    expect(probe.stats.lastRttMs).toBe(23)
    ws.onmessage?.({ data: ws.sent[0] })
    expect(probe.stats.unmatched).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(ws.sent).toHaveLength(2)
    ws.onclose?.({ code: 1006 })
    expect(probe.stats.state).toBe('closed')
    expect(probe.stats.lastCloseCode).toBe(1006)
    vi.advanceTimersByTime(3000)
    expect(FakeSocket.last).not.toBe(ws)
    expect(logs[0]).toBe('ws target wss://example.test/echo')
  })
})
