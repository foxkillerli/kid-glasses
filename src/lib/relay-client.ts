import { RELAY_PROTOCOL, RELAY_TIMING, STORE_KEYS } from './relay-config'
import type { AsyncStore } from './store'

export interface WsLike {
  readonly readyState: number
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type WsFactory = (url: string, protocols: string[]) => WsLike

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(id: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(id: unknown): void
}

export type RelayState = 'starting' | 'need-pair' | 'connecting' | 'online' | 'offline'

export interface RelayItem {
  seq: number
  from: 'kid' | 'glasses' | 'fast'
  text: string
  at: number
  session: string | null
  edited?: boolean
  cid?: string
}

export interface OutboxEntry {
  cid: string
  text: string
  at: number
  tries: number
}

export interface RelayEvents {
  state(state: RelayState, detail: string): void
  items(items: RelayItem[], kind: 'live' | 'replay' | 'history'): void
  posted(seq: number, cid: string | undefined, dup: boolean): void
  error(code: string, message: string, cid: string | undefined): void
  asr(kind: 'partial' | 'final', text: string): void
  webhook(result: string, status: number | null): void
  outbox(entries: OutboxEntry[]): void
}

export interface RelayClientDeps {
  url: string
  ws: WsFactory
  store: AsyncStore
  timers: Timers
  now: () => number
  random: () => number
  uuid: () => string
  events: Partial<RelayEvents>
  log?: (m: string) => void
  timing?: Partial<typeof RELAY_TIMING>
}

const OPEN = 1
const CONNECTING = 0
export const CLOSE_UNAUTHORIZED = 4401

export function backoffDelay(attempt: number, random: number, baseMs: number = RELAY_TIMING.backoffBaseMs, maxMs: number = RELAY_TIMING.backoffMaxMs): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16))
  return Math.round(cap / 2 + (random * cap) / 2)
}

export function newCid(randomUUID?: () => string, getRandomValues?: (a: Uint8Array) => Uint8Array): string {
  if (randomUUID) return randomUUID()
  const b = new Uint8Array(16)
  if (getRandomValues) getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
}

export class RelayClient {
  private ws: WsLike | null = null
  private token: string | null = null
  private lastSeq = 0
  private outbox: OutboxEntry[] = []
  private attempt = 0
  private reconnectTimer: unknown = null
  private pingTimer: unknown = null
  private connectTimer: unknown = null
  private probeTimer: unknown = null
  private readonly retryTimers = new Map<string, unknown>()
  private catchingUp = false
  private catchUpMax = 0
  private lastFrameAt = 0
  private stateValue: RelayState = 'starting'
  private wantHistory = true
  private readonly t: typeof RELAY_TIMING
  private stopped = false

  constructor(private readonly deps: RelayClientDeps) {
    this.t = { ...RELAY_TIMING, ...deps.timing }
  }

  get state(): RelayState {
    return this.stateValue
  }

  get pending(): OutboxEntry[] {
    return [...this.outbox]
  }

  get seq(): number {
    return this.lastSeq
  }

  get hasToken(): boolean {
    return !!this.token
  }

  private log(m: string) {
    this.deps.log?.(m)
  }

  private setState(s: RelayState, detail = '') {
    this.stateValue = s
    this.deps.events.state?.(s, detail)
  }

  async init(): Promise<void> {
    this.token = (await this.deps.store.get(STORE_KEYS.token)) || null
    this.lastSeq = Number(await this.deps.store.get(STORE_KEYS.lastSeq)) || 0
    try {
      const raw = JSON.parse((await this.deps.store.get(STORE_KEYS.outbox)) ?? '[]') as OutboxEntry[]
      const now = this.deps.now()
      this.outbox = Array.isArray(raw) ? raw.filter(e => e && typeof e.cid === 'string' && typeof e.text === 'string' && now - e.at < this.t.outboxTtlMs) : []
    } catch {
      this.outbox = []
    }
    this.deps.events.outbox?.(this.pending)
  }

  start(): void {
    this.stopped = false
    if (!this.token) {
      this.setState('need-pair')
      return
    }
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000, 'stop')
    } catch {
      return
    }
  }

  async setToken(token: string): Promise<void> {
    this.token = token
    await this.deps.store.set(STORE_KEYS.token, token)
    this.attempt = 0
    this.connect()
  }

  async forgetToken(): Promise<void> {
    this.token = null
    await this.deps.store.remove(STORE_KEYS.token)
  }

  nudge(reason: string): void {
    if (this.stopped || !this.token) return
    if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) {
      if (this.stateValue === 'online') this.probe(reason)
      return
    }
    this.log(`relay nudge (${reason})`)
    this.attempt = 0
    this.connect()
  }

  private probe(reason: string): void {
    const sentAt = this.deps.now()
    if (!this.sendJson({ t: 'ping' })) return
    if (this.probeTimer !== null) this.deps.timers.clearTimeout(this.probeTimer)
    this.probeTimer = this.deps.timers.setTimeout(() => {
      this.probeTimer = null
      if (this.lastFrameAt > sentAt) return
      this.log(`relay probe (${reason}) got no answer; reconnecting`)
      this.dropSocket(4000, 'probe')
    }, this.t.probeMs)
  }

  private dropSocket(code: number, reason: string): void {
    const ws = this.ws
    this.ws = null
    if (ws) ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws?.close(code, reason)
    } catch {
      this.log('relay close failed')
    }
    this.attempt = 0
    this.clearTimers()
    this.connect()
  }

  private clearTimers() {
    for (const [timer, clear] of [
      [this.reconnectTimer, 'clearTimeout'],
      [this.connectTimer, 'clearTimeout'],
      [this.probeTimer, 'clearTimeout'],
    ] as const) if (timer !== null) this.deps.timers[clear](timer)
    if (this.pingTimer !== null) this.deps.timers.clearInterval(this.pingTimer)
    for (const t of this.retryTimers.values()) this.deps.timers.clearTimeout(t)
    this.retryTimers.clear()
    this.reconnectTimer = null
    this.connectTimer = null
    this.probeTimer = null
    this.pingTimer = null
  }

  private connect(): void {
    if (this.stopped || !this.token) return
    this.clearTimers()
    if (this.ws) {
      const old = this.ws
      this.ws = null
      old.onopen = old.onmessage = old.onclose = old.onerror = null
      try {
        old.close(1000, 'replaced')
      } catch {
        this.log('relay old socket close failed')
      }
    }
    this.setState('connecting')
    let ws: WsLike
    try {
      ws = this.deps.ws(this.deps.url, [RELAY_PROTOCOL])
    } catch {
      this.scheduleReconnect('open-failed')
      return
    }
    this.ws = ws
    this.connectTimer = this.deps.timers.setTimeout(() => {
      this.connectTimer = null
      if (this.ws === ws && this.stateValue !== 'online') {
        this.log('relay connect timed out')
        this.ws = null
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
        try {
          ws.close(4000, 'connect timeout')
        } catch {
          this.log('relay close failed')
        }
        void this.onClosed(4000)
      }
    }, this.t.connectTimeoutMs)
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.lastFrameAt = this.deps.now()
      this.sendJson({ t: 'auth', token: this.token })
    }
    ws.onmessage = ev => {
      if (this.ws !== ws) return
      this.lastFrameAt = this.deps.now()
      if (typeof ev.data === 'string') this.onFrame(ev.data)
    }
    ws.onclose = ev => {
      if (this.ws !== ws) return
      this.ws = null
      void this.onClosed(ev.code)
    }
    ws.onerror = () => {
      this.log('relay socket error')
    }
  }

  private async onClosed(code: number): Promise<void> {
    this.clearTimers()
    if (code === CLOSE_UNAUTHORIZED) {
      this.log('relay token rejected; pairing needed')
      await this.forgetToken()
      this.setState('need-pair', 'token rejected')
      return
    }
    this.scheduleReconnect(`closed ${code}`)
  }

  private scheduleReconnect(why: string): void {
    if (this.stopped) return
    const delay = backoffDelay(this.attempt, this.deps.random(), this.t.backoffBaseMs, this.t.backoffMaxMs)
    this.attempt++
    this.setState('offline', `${why}; retry in ${Math.ceil(delay / 1000)}s`)
    this.reconnectTimer = this.deps.timers.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendJson(msg: Record<string, unknown>): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private onFrame(data: string): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(data) as Record<string, unknown>
    } catch {
      return
    }
    switch (m.t) {
      case 'auth.ok':
        this.attempt = 0
        if (this.connectTimer !== null) this.deps.timers.clearTimeout(this.connectTimer)
        this.connectTimer = null
        this.catchingUp = true
        this.catchUpMax = 0
        this.sendJson({ t: 'hello', lastSeq: this.lastSeq })
        if (this.wantHistory) this.sendJson({ t: 'history', limit: 20 })
        this.startPing()
        this.setState('online')
        this.flushOutbox()
        return
      case 'msg':
        this.acceptItems([m as unknown as RelayItem], this.stateValue === 'online' ? 'live' : 'replay')
        return
      case 'replay.done':
        this.catchingUp = false
        this.bumpSeq(Math.max(Number(m.upTo) || 0, this.catchUpMax))
        return
      case 'history':
        this.wantHistory = false
        this.acceptItems((Array.isArray(m.items) ? m.items : []) as RelayItem[], 'history')
        return
      case 'posted': {
        const seq = Number(m.seq)
        const cid = typeof m.cid === 'string' ? m.cid : undefined
        if (cid) this.ackOutbox(cid)
        this.bumpSeq(seq)
        this.deps.events.posted?.(seq, cid, m.dup === true)
        if (typeof m.text === 'string') this.deps.events.items?.([{ seq, from: 'glasses', text: m.text, at: this.deps.now(), session: null, ...(cid ? { cid } : {}) }], 'live')
        return
      }
      case 'error': {
        const cid = typeof m.cid === 'string' ? m.cid : undefined
        if (cid) this.failOutbox(cid, String(m.code))
        this.deps.events.error?.(String(m.code), String(m.message), cid)
        return
      }
      case 'asr.partial':
      case 'asr.final':
        this.deps.events.asr?.(m.t === 'asr.partial' ? 'partial' : 'final', String(m.text ?? ''))
        return
      case 'kid-webhook':
        this.deps.events.webhook?.(String(m.result), typeof m.status === 'number' ? m.status : null)
        return
      default:
        return
    }
  }

  private acceptItems(items: RelayItem[], kind: 'live' | 'replay' | 'history'): void {
    const valid = items.filter(i => i && typeof i.seq === 'number' && typeof i.text === 'string')
    for (const i of valid) if (i.from === 'glasses' && i.cid) this.ackOutbox(i.cid)
    if (kind !== 'history') for (const i of valid) this.bumpSeq(i.seq)
    if (valid.length) this.deps.events.items?.(valid, kind)
  }

  private bumpSeq(seq: number): void {
    if (this.catchingUp) {
      if (Number.isFinite(seq) && seq > this.catchUpMax) this.catchUpMax = seq
      return
    }
    if (Number.isFinite(seq) && seq > this.lastSeq) {
      this.lastSeq = seq
      void this.deps.store.set(STORE_KEYS.lastSeq, String(seq))
    }
  }

  private startPing(): void {
    if (this.pingTimer !== null) this.deps.timers.clearInterval(this.pingTimer)
    this.pingTimer = this.deps.timers.setInterval(() => {
      if (this.deps.now() - this.lastFrameAt > this.t.idleMs) {
        this.log('relay idle; reconnecting')
        const ws = this.ws
        this.ws = null
        try {
          ws?.close(4000, 'idle')
        } catch {
          this.log('relay idle close failed')
        }
        void this.onClosed(4000)
        return
      }
      this.sendJson({ t: 'ping' })
    }, this.t.pingMs)
  }

  private persistOutbox(): Promise<void> {
    this.deps.events.outbox?.(this.pending)
    return this.deps.store.set(STORE_KEYS.outbox, JSON.stringify(this.outbox)).catch(() => this.log('relay outbox save failed'))
  }

  private ackOutbox(cid: string): void {
    const before = this.outbox.length
    this.outbox = this.outbox.filter(e => e.cid !== cid)
    const t = this.retryTimers.get(cid)
    if (t !== undefined) this.deps.timers.clearTimeout(t)
    this.retryTimers.delete(cid)
    if (this.outbox.length !== before) void this.persistOutbox()
  }

  private failOutbox(cid: string, code: string): void {
    const e = this.outbox.find(x => x.cid === cid)
    if (!e) return
    e.tries++
    const permanent = code === 'empty-text' || code === 'SlackConfigError' || code === 'ChannelNotAllowedError'
    if (permanent || e.tries >= this.t.maxSendTries) {
      this.outbox = this.outbox.filter(x => x !== e)
      void this.persistOutbox()
      return
    }
    void this.persistOutbox()
    const delay = Math.min(this.t.retryBaseMs * 3 ** (e.tries - 1), 5 * 60_000)
    const old = this.retryTimers.get(cid)
    if (old !== undefined) this.deps.timers.clearTimeout(old)
    this.retryTimers.set(
      cid,
      this.deps.timers.setTimeout(() => {
        this.retryTimers.delete(cid)
        const still = this.outbox.find(x => x.cid === cid)
        if (still && this.stateValue === 'online') this.sendJson({ t: 'say', text: still.text, cid })
      }, delay),
    )
  }

  private flushOutbox(): void {
    const now = this.deps.now()
    this.outbox = this.outbox.filter(e => now - e.at < this.t.outboxTtlMs)
    for (const e of this.outbox) this.sendJson({ t: 'say', text: e.text, cid: e.cid })
  }

  async say(text: string): Promise<string | null> {
    const clean = text.trim()
    if (!clean || this.outbox.length >= this.t.outboxMax) return null
    const entry: OutboxEntry = { cid: this.deps.uuid(), text: clean, at: this.deps.now(), tries: 0 }
    await this.deps.store.set(STORE_KEYS.outbox, JSON.stringify([...this.outbox, entry])).catch(() => this.log('relay outbox save failed'))
    this.outbox = [...this.outbox, entry]
    this.deps.events.outbox?.(this.pending)
    if (this.stateValue === 'online') this.sendJson({ t: 'say', text: entry.text, cid: entry.cid })
    return entry.cid
  }

  audioStart(lang?: string): string | null {
    if (this.stateValue !== 'online') return null
    const cid = this.deps.uuid()
    return this.sendJson({ t: 'audio.start', cid, ...(lang ? { lang } : {}) }) ? cid : null
  }

  audioFrame(pcm: Uint8Array): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN || this.stateValue !== 'online') return false
    try {
      ws.send(pcm)
      return true
    } catch {
      return false
    }
  }

  audioStop(): void {
    this.sendJson({ t: 'audio.stop' })
  }

  audioCancel(): void {
    this.sendJson({ t: 'audio.cancel' })
  }

  newSession(): void {
    this.sendJson({ t: 'session.new' })
  }
}
