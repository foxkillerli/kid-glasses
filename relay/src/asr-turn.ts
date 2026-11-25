import { CLOSE_STREAM, DeepgramUpgradeError, FINALIZE, KEEP_ALIVE, TranscriptAssembler, parseDeepgramEvent, type AsrLang } from './deepgram'
import { errorName } from './log'

export interface AsrSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number }) => void): void
}

export interface AsrConnector {
  connect(lang: AsrLang, fallback: boolean, signal?: AbortSignal): Promise<AsrSocket>
}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export const ASR_LIMITS = {
  connectTimeoutMs: 5_000,
  keepAliveMs: 3_000,
  tickMs: 1_000,
  noAudioMs: 10_000,
  finalizeWaitMs: 1_500,
  finalWaitMs: 5_000,
  maxAudioMs: 62_000,
  retryBufferMs: 15_000,
  maxReconnects: 2,
  retryDelayMs: 300,
}

export type AsrLimits = typeof ASR_LIMITS

export const BYTES_PER_MS = 32

export type AsrErrorCode = 'asr-interrupted' | 'asr-connect-failed' | 'asr-rejected' | 'asr-no-audio'

export type AsrOutcome =
  | { ok: true; text: string; reason: 'finalize' | 'close' | 'timeout' }
  | { ok: false; code: AsrErrorCode; message: string }
  | { ok: false; code: null }

export interface AsrTurnDeps {
  connector: AsrConnector
  lang: AsrLang
  timers: Timers
  now: () => number
  limits?: Partial<AsrLimits>
  log: (m: string) => void
  onPartial: (text: string) => void
  onDone: (o: AsrOutcome) => void
}

type TimerName = 'tick' | 'connect' | 'retry' | 'finalize' | 'final'

interface Chunk {
  at: number
  data: Uint8Array
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export class AsrTurn {
  private readonly L: AsrLimits
  private ws: AsrSocket | null = null
  private gen = 0
  private readonly assembler = new TranscriptAssembler()
  private buffer: Chunk[] = []
  private bytesIn = 0
  private frames = 0
  private finalizedBytes = 0
  private streamBase = 0
  private reconnects = 0
  private fallback = false
  private everConnected = false
  private stopRequested = false
  private finalizeSent = false
  private closeSent = false
  private metadataSeen = false
  private done = false
  private lastPartial = ''
  private readonly startedAt: number
  private firstPartialAt: number | null = null
  private stopAt: number | null = null
  private lastAudioAt: number
  private lastSentAt: number
  private closeCode: number | null = null
  private readonly handles = new Map<TimerName, unknown>()
  private inflight: { abort: AbortController; settle: () => void } | null = null

  constructor(private readonly deps: AsrTurnDeps) {
    this.L = { ...ASR_LIMITS, ...deps.limits }
    this.startedAt = deps.now()
    this.lastAudioAt = this.startedAt
    this.lastSentAt = this.startedAt
  }

  get finished(): boolean {
    return this.done
  }

  get stopping(): boolean {
    return this.stopRequested
  }

  start(): Promise<void> {
    this.arm('tick', this.L.tickMs, () => this.tick())
    return this.open()
  }

  push(data: ArrayBuffer | ArrayBufferView): void {
    if (this.done || this.stopRequested) return
    const bytes = toBytes(data)
    if (bytes.length === 0) return
    if (this.bytesIn + bytes.length > this.L.maxAudioMs * BYTES_PER_MS) {
      this.deps.log('asr max-length')
      this.stop('max-length')
      return
    }
    this.buffer.push({ at: this.bytesIn, data: bytes })
    this.bytesIn += bytes.length
    this.frames++
    this.lastAudioAt = this.deps.now()
    this.trim()
    if (this.ws) this.sendAudio(bytes)
  }

  stop(reason: string): void {
    if (this.done || this.stopRequested) return
    this.stopRequested = true
    this.stopAt = this.deps.now()
    this.deps.log(`asr stop (${reason})`)
    this.arm('final', this.L.finalWaitMs, () => this.complete('timeout'))
    if (this.ws) this.sendFinalize()
  }

  cancel(reason: string): void {
    if (this.done) return
    this.deps.log(`asr cancel (${reason})`)
    this.finish(`cancel-${reason}`, 0)
    this.deps.onDone({ ok: false, code: null })
  }

  private open(): Promise<void> {
    const gen = ++this.gen
    let settled = false
    const abort = new AbortController()
    let release: () => void = () => {}
    const released = new Promise<void>(r => (release = r))
    const slot = { abort, settle: () => release() }
    this.inflight = slot
    const settle = () => {
      settled = true
      if (this.inflight === slot) this.inflight = null
      release()
    }
    let attempt: Promise<AsrSocket>
    try {
      attempt = this.deps.connector.connect(this.deps.lang, this.fallback, abort.signal)
    } catch (err) {
      attempt = Promise.reject(err)
    }
    this.arm('connect', this.L.connectTimeoutMs, () => {
      if (settled || gen !== this.gen || this.done) return
      settle()
      abort.abort()
      this.deps.log('asr connect timeout')
      this.lost('connect-timeout', null)
    })
    const handled = attempt.then(
      sock => {
        if (settled || gen !== this.gen || this.done) {
          this.safeClose(sock)
          return
        }
        settle()
        this.clear('connect')
        this.attach(sock, gen)
      },
      err => {
        if (settled || gen !== this.gen || this.done) return
        settle()
        this.clear('connect')
        const status = err instanceof DeepgramUpgradeError ? err.status : null
        this.deps.log(`asr connect failed status=${status ?? 'none'} err=${errorName(err)} fallback=${this.fallback ? 1 : 0}`)
        if (status === 401 || status === 402 || status === 403) {
          this.fail('asr-rejected', `transcription service refused the request (http ${status})`)
          return
        }
        if (status === 400 && !this.fallback) {
          this.fallback = true
          return this.open()
        }
        this.lost('connect-failed', status)
      },
    )
    return Promise.race([handled, released])
  }

  private attach(sock: AsrSocket, gen: number): void {
    this.ws = sock
    this.everConnected = true
    this.streamBase = this.finalizedBytes
    this.finalizeSent = false
    this.closeSent = false
    this.metadataSeen = false
    sock.addEventListener('message', ev => {
      if (gen !== this.gen || this.done || typeof ev.data !== 'string') return
      this.onMessage(ev.data)
    })
    sock.addEventListener('close', ev => {
      if (gen !== this.gen || this.done) return
      this.onClose(typeof ev.code === 'number' ? ev.code : null, 'close')
    })
    sock.addEventListener('error', () => {
      if (gen !== this.gen || this.done) return
      this.onClose(null, 'error')
    })
    if (!this.canReplay()) {
      this.deps.log('asr retry impossible buffer-overflow')
      this.fail(this.reconnects > 0 ? 'asr-interrupted' : 'asr-connect-failed', this.reconnects > 0 ? 'transcription ended early; nothing was sent' : 'could not reach the transcription service')
      return
    }
    for (const c of this.unfinalized()) {
      if (this.ws !== sock) return
      this.sendAudio(c)
    }
    if (this.stopRequested && this.ws === sock) this.sendFinalize()
  }

  private unfinalized(): Uint8Array[] {
    const out: Uint8Array[] = []
    for (const c of this.buffer) {
      const end = c.at + c.data.length
      if (end <= this.finalizedBytes) continue
      out.push(c.at < this.finalizedBytes ? c.data.subarray(this.finalizedBytes - c.at) : c.data)
    }
    return out
  }

  private canReplay(): boolean {
    const first = this.buffer[0]
    return first ? first.at <= this.finalizedBytes : this.bytesIn <= this.finalizedBytes
  }

  private trim(): void {
    const keepFrom = Math.max(this.finalizedBytes, this.bytesIn - this.L.retryBufferMs * BYTES_PER_MS)
    while (this.buffer.length) {
      const c = this.buffer[0]
      if (c.at + c.data.length <= keepFrom) this.buffer.shift()
      else break
    }
  }

  private onMessage(data: string): void {
    const e = parseDeepgramEvent(data)
    if (!e) return
    if (e.kind === 'metadata') {
      this.metadataSeen = true
      return
    }
    if (e.kind !== 'results') return
    if (e.isFinal) {
      const end = this.streamBase + Math.floor((e.start + e.duration) * 16000) * 2
      if (end > this.finalizedBytes) this.finalizedBytes = Math.min(end, this.bytesIn)
      this.trim()
    }
    const { partial } = this.assembler.feed(e)
    if (partial && partial !== this.lastPartial) {
      this.lastPartial = partial
      if (this.firstPartialAt === null) this.firstPartialAt = this.deps.now()
      this.deps.onPartial(partial)
    }
    if (e.fromFinalize && this.stopRequested) this.complete('finalize')
  }

  private onClose(code: number | null, kind: 'close' | 'error'): void {
    if (code !== null) this.closeCode = code
    this.ws = null
    this.clear('finalize')
    const allFinal = this.finalizedBytes >= this.bytesIn
    if (this.stopRequested && ((this.closeSent && (code === 1000 || this.metadataSeen)) || (this.finalizeSent && code === 1000 && allFinal))) {
      this.complete('close')
      return
    }
    this.lost(kind, code)
  }

  private lost(reason: string, code: number | null): void {
    if (this.done) return
    this.gen++
    const old = this.ws
    this.ws = null
    if (old) this.safeClose(old)
    const failCode: AsrErrorCode = this.everConnected ? 'asr-interrupted' : 'asr-connect-failed'
    const failMessage = this.everConnected ? 'transcription ended early; nothing was sent' : 'could not reach the transcription service'
    if (this.reconnects >= this.L.maxReconnects) {
      this.fail(failCode, failMessage)
      return
    }
    if (!this.canReplay()) {
      this.deps.log('asr retry impossible buffer-overflow')
      this.fail(failCode, failMessage)
      return
    }
    this.reconnects++
    this.deps.log(`asr retry n=${this.reconnects} reason=${reason} close=${code ?? 'none'}`)
    this.arm('retry', this.L.retryDelayMs, () => {
      if (!this.done) void this.open()
    })
  }

  private sendAudio(bytes: Uint8Array): void {
    const ws = this.ws
    if (!ws) return
    try {
      ws.send(bytes)
      this.lastSentAt = this.deps.now()
    } catch (err) {
      this.deps.log(`asr send failed ${errorName(err)}`)
      this.lost('send-failed', null)
    }
  }

  private sendText(s: string): boolean {
    const ws = this.ws
    if (!ws) return false
    try {
      ws.send(s)
      this.lastSentAt = this.deps.now()
      return true
    } catch (err) {
      this.deps.log(`asr send failed ${errorName(err)}`)
      this.lost('send-failed', null)
      return false
    }
  }

  private sendFinalize(): void {
    if (!this.ws || this.finalizeSent) return
    this.finalizeSent = true
    if (!this.sendText(FINALIZE)) return
    this.arm('finalize', this.L.finalizeWaitMs, () => this.sendCloseStream())
  }

  private sendCloseStream(): void {
    if (!this.ws || this.closeSent) return
    this.closeSent = true
    this.sendText(CLOSE_STREAM)
  }

  private tick(): void {
    if (this.done) return
    const now = this.deps.now()
    if (!this.stopRequested && now - this.lastAudioAt >= this.L.noAudioMs) {
      this.fail('asr-no-audio', 'no audio from the glasses')
      return
    }
    if (this.ws && now - this.lastSentAt >= this.L.keepAliveMs) this.sendText(KEEP_ALIVE)
    if (!this.done) this.arm('tick', this.L.tickMs, () => this.tick())
  }

  private complete(reason: 'finalize' | 'close' | 'timeout'): void {
    if (this.done) return
    const text = reason === 'timeout' ? this.assembler.partial() : this.assembler.finalText()
    this.finish(reason, text.length)
    this.deps.onDone({ ok: true, text, reason })
  }

  private fail(code: AsrErrorCode, message: string): void {
    if (this.done) return
    this.finish(code, 0)
    this.deps.onDone({ ok: false, code, message })
  }

  private finish(reason: string, len: number): void {
    this.done = true
    for (const name of [...this.handles.keys()]) this.clear(name)
    const pending = this.inflight
    this.inflight = null
    if (pending) {
      pending.abort.abort()
      pending.settle()
    }
    const ws = this.ws
    this.ws = null
    this.gen++
    if (ws) {
      if (!this.closeSent) this.trySend(ws, CLOSE_STREAM)
      this.safeClose(ws)
    }
    const now = this.deps.now()
    this.deps.log(
      [
        `asr done reason=${reason}`,
        `lang=${this.deps.lang}`,
        `bytes=${this.bytesIn}`,
        `frames=${this.frames}`,
        `audioMs=${Math.round(this.bytesIn / BYTES_PER_MS)}`,
        `firstPartialMs=${this.firstPartialAt === null ? 'none' : this.firstPartialAt - this.startedAt}`,
        `finalMs=${this.stopAt === null ? 'none' : now - this.stopAt}`,
        `retries=${this.reconnects}`,
        `fallback=${this.fallback ? 1 : 0}`,
        `close=${this.closeCode ?? 'none'}`,
        `len=${len}`,
      ].join(' '),
    )
  }

  private trySend(ws: AsrSocket, s: string): void {
    try {
      ws.send(s)
    } catch {
      return
    }
  }

  private safeClose(ws: AsrSocket): void {
    try {
      ws.close(1000, 'done')
    } catch {
      return
    }
  }

  private arm(name: TimerName, ms: number, fn: () => void): void {
    this.clear(name)
    this.handles.set(
      name,
      this.deps.timers.set(() => {
        this.handles.delete(name)
        fn()
      }, ms),
    )
  }

  private clear(name: TimerName): void {
    const h = this.handles.get(name)
    if (h === undefined) return
    this.handles.delete(name)
    this.deps.timers.clear(h)
  }
}
