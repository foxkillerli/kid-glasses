export type WsState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export interface WsProbeStats {
  state: WsState
  opens: number
  closes: number
  pingsSent: number
  pongs: number
  lastRttMs: number
  lastPongAt: number
  lastCloseCode: number
  unmatched: number
}

export interface WsProbeOptions {
  url: string
  pingEveryMs: number
  reconnectMs: number
  now: () => number
  log: (msg: string) => void
  makeSocket?: (url: string) => WebSocket
}

export class WsProbe {
  readonly stats: WsProbeStats = {
    state: 'idle',
    opens: 0,
    closes: 0,
    pingsSent: 0,
    pongs: 0,
    lastRttMs: 0,
    lastPongAt: 0,
    lastCloseCode: 0,
    unmatched: 0,
  }
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private nextId = 1
  private inflight = new Map<number, number>()

  constructor(private readonly opts: WsProbeOptions) {}

  start(): void {
    this.connect()
  }

  reconnectNow(): void {
    this.opts.log('ws manual reconnect')
    this.teardown()
    this.connect()
  }

  private connect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stats.state = 'connecting'
    let ws: WebSocket
    try {
      ws = this.opts.makeSocket ? this.opts.makeSocket(this.opts.url) : new WebSocket(this.opts.url)
    } catch (err) {
      this.stats.state = 'error'
      this.opts.log(`ws ctor error ${String(err).slice(0, 60)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    const openedAt = this.opts.now()
    ws.onopen = () => {
      this.stats.state = 'open'
      this.stats.opens++
      this.opts.log(`ws open #${this.stats.opens} in ${this.opts.now() - openedAt}ms`)
      this.sendPing()
      this.pingTimer = setInterval(() => this.sendPing(), this.opts.pingEveryMs)
    }
    ws.onmessage = ev => this.onMessage(ev.data)
    ws.onerror = () => {
      this.stats.state = 'error'
      this.opts.log('ws error')
    }
    ws.onclose = ev => {
      this.stats.closes++
      this.stats.lastCloseCode = ev.code
      this.stats.state = 'closed'
      this.opts.log(`ws close code=${ev.code} after ${this.stats.pongs} pongs`)
      this.clearPing()
      if (this.ws === ws) {
        this.ws = null
        this.scheduleReconnect()
      }
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: { t?: string; id?: number; ts?: number }
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.t !== 'ping' || typeof msg.id !== 'number') return
    const sentAt = this.inflight.get(msg.id)
    if (sentAt === undefined) {
      this.stats.unmatched++
      return
    }
    this.inflight.delete(msg.id)
    const now = this.opts.now()
    this.stats.pongs++
    this.stats.lastRttMs = now - sentAt
    this.stats.lastPongAt = now
    this.opts.log(`pong #${msg.id} rtt=${this.stats.lastRttMs}ms`)
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== 1) return
    const id = this.nextId++
    const ts = this.opts.now()
    this.inflight.set(id, ts)
    if (this.inflight.size > 50) {
      const oldest = this.inflight.keys().next().value
      if (oldest !== undefined) this.inflight.delete(oldest)
    }
    try {
      this.ws.send(JSON.stringify({ t: 'ping', id, ts }))
      this.stats.pingsSent++
    } catch (err) {
      this.opts.log(`ws send error ${String(err).slice(0, 60)}`)
    }
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.opts.reconnectMs)
  }

  private teardown(): void {
    this.clearPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.onerror = null
      ws.onopen = null
      try {
        ws.close()
      } catch {
        return
      }
    }
  }
}
