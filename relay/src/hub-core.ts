import { CLOSE_STREAM, TranscriptAssembler, parseDeepgramMessage } from './deepgram'
import type { FastLane } from './fast-lane'
import { HistoryStore, type HistoryItem, type KvStorage } from './history'
import { parseClientMessage, type ServerMessage } from './protocol'
import { cleanText, fromSlack, toSlack } from './sanitize'
import type { KidMessage } from './slack-events'
import type { PostResult } from './slack-client'

export interface DeviceSocket {
  send(data: string): void
}

export interface AsrSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (ev: { data?: unknown }) => void): void
}

export interface HubDeps {
  storage: KvStorage
  sockets: () => DeviceSocket[]
  slack: { postToKid(text: string, threadTs: string | null): Promise<PostResult> }
  asr: { connect(): Promise<AsrSocket> } | null
  fastLane: FastLane
  now: () => number
  log?: (message: string) => void
}

export interface Session {
  id: string
  threadTs: string | null
  startedAt: number
  lastAt: number
}

export const SESSION_KEY = 'meta:session'
export const SEEN_KEY = 'meta:seen'
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SEEN_CAP = 200
export const PENDING_AUDIO_CAP = 100

interface AsrState {
  socket: AsrSocket | null
  assembler: TranscriptAssembler
  pending: Array<ArrayBuffer | ArrayBufferView>
  stopRequested: boolean
  finished: boolean
}

export class HubCore {
  readonly history: HistoryStore
  private asr: AsrState | null = null

  constructor(private readonly deps: HubDeps) {
    this.history = new HistoryStore(deps.storage)
  }

  private log(m: string): void {
    this.deps.log?.(m)
  }

  send(ws: DeviceSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      this.log(`send failed ${String(err)}`)
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.deps.sockets()) this.send(ws, msg)
  }

  private toWire(i: HistoryItem) {
    return { seq: i.seq, from: i.from, text: i.text, at: i.at }
  }

  async currentSession(forceNew = false): Promise<Session> {
    const now = this.deps.now()
    const s = await this.deps.storage.get<Session>(SESSION_KEY)
    if (!forceNew && s && now - s.lastAt < SESSION_IDLE_MS) return s
    const fresh: Session = { id: `s${now.toString(36)}`, threadTs: null, startedAt: now, lastAt: now }
    await this.deps.storage.put(SESSION_KEY, fresh)
    return fresh
  }

  async onDeviceMessage(ws: DeviceSocket, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (typeof data !== 'string') {
      this.onAudioFrame(data)
      return
    }
    const parsed = parseClientMessage(data)
    if (!parsed.ok) {
      this.send(ws, { t: 'error', code: 'bad-message', message: parsed.error })
      return
    }
    const m = parsed.msg
    switch (m.t) {
      case 'hello': {
        const session = await this.currentSession()
        this.send(ws, { t: 'hello', session: session.id, lastSeq: await this.history.lastSeq(), fastLane: this.deps.fastLane.enabled })
        if (m.lastSeq !== undefined) for (const i of await this.history.since(m.lastSeq)) this.send(ws, { t: 'msg', ...this.toWire(i) })
        return
      }
      case 'ping':
        this.send(ws, { t: 'pong' })
        return
      case 'say':
        await this.sayFromGlasses(m.text)
        return
      case 'audio.start':
        await this.startAsr(ws)
        return
      case 'audio.stop':
        this.stopAsr('device')
        return
      case 'history': {
        const page = await this.history.page(m.before ?? null, m.limit ?? 20)
        this.send(ws, { t: 'history', items: page.items.map(i => this.toWire(i)), more: page.more })
        return
      }
      case 'session.new':
        await this.currentSession(true)
        return
    }
  }

  async sayFromGlasses(raw: string): Promise<HistoryItem | null> {
    const slackText = toSlack(raw)
    if (!slackText) {
      this.broadcast({ t: 'error', code: 'empty-text', message: 'nothing to send' })
      return null
    }
    const session = await this.currentSession()
    let posted: PostResult
    try {
      posted = await this.deps.slack.postToKid(slackText, session.threadTs)
    } catch (err) {
      const e = err as Error
      this.log(`slack post failed ${e.name}: ${e.message}`)
      this.broadcast({ t: 'error', code: e.name || 'slack-error', message: e.message })
      return null
    }
    const next: Session = { ...session, threadTs: session.threadTs ?? posted.ts, lastAt: this.deps.now() }
    await this.deps.storage.put(SESSION_KEY, next)
    const item = await this.history.append({
      from: 'glasses',
      text: cleanText(raw),
      slackTs: posted.ts,
      threadTs: next.threadTs,
      at: this.deps.now(),
    })
    this.broadcast({ t: 'posted', seq: item.seq, text: item.text })
    if (this.deps.fastLane.enabled) {
      const answer = await this.deps.fastLane.answer(item.text)
      if (answer) {
        const fast = await this.history.append({ from: 'fast', text: cleanText(answer), slackTs: null, threadTs: next.threadTs, at: this.deps.now() })
        this.broadcast({ t: 'msg', ...this.toWire(fast) })
      }
    }
    return item
  }

  async onKidMessage(msg: KidMessage): Promise<HistoryItem | null> {
    const seen = (await this.deps.storage.get<string[]>(SEEN_KEY)) ?? []
    if (seen.includes(msg.eventId)) return null
    await this.deps.storage.put(SEEN_KEY, [...seen, msg.eventId].slice(-SEEN_CAP))
    const text = fromSlack(msg.text)
    if (!text) return null
    const item = await this.history.append({ from: 'kid', text, slackTs: msg.ts, threadTs: msg.threadTs, at: this.deps.now() })
    this.broadcast({ t: 'msg', ...this.toWire(item) })
    const session = await this.deps.storage.get<Session>(SESSION_KEY)
    if (session) await this.deps.storage.put(SESSION_KEY, { ...session, lastAt: this.deps.now() })
    return item
  }

  get asrActive(): boolean {
    return !!this.asr && !this.asr.finished
  }

  async startAsr(ws: DeviceSocket): Promise<void> {
    if (!this.deps.asr) {
      this.send(ws, { t: 'error', code: 'asr-not-configured', message: 'DEEPGRAM_API_KEY is not set' })
      return
    }
    if (this.asrActive) return
    const state: AsrState = { socket: null, assembler: new TranscriptAssembler(), pending: [], stopRequested: false, finished: false }
    this.asr = state
    let socket: AsrSocket
    try {
      socket = await this.deps.asr.connect()
    } catch (err) {
      state.finished = true
      this.broadcast({ t: 'error', code: 'asr-connect-failed', message: String(err) })
      return
    }
    state.socket = socket
    socket.addEventListener('message', ev => {
      if (typeof ev.data !== 'string') return
      const r = parseDeepgramMessage(ev.data)
      if (!r) return
      const { partial } = state.assembler.feed(r)
      if (partial) this.broadcast({ t: 'asr.partial', text: partial })
    })
    socket.addEventListener('close', () => {
      void this.finishAsr(state)
    })
    socket.addEventListener('error', () => {
      void this.finishAsr(state)
    })
    for (const frame of state.pending) socket.send(frame)
    state.pending = []
    if (state.stopRequested) socket.send(CLOSE_STREAM)
  }

  onAudioFrame(frame: ArrayBuffer | ArrayBufferView): void {
    const s = this.asr
    if (!s || s.finished || s.stopRequested) return
    if (s.socket) s.socket.send(frame)
    else if (s.pending.length < PENDING_AUDIO_CAP) s.pending.push(frame)
  }

  stopAsr(reason: string): void {
    const s = this.asr
    if (!s || s.finished || s.stopRequested) return
    s.stopRequested = true
    this.log(`asr stop (${reason})`)
    if (s.socket) {
      try {
        s.socket.send(CLOSE_STREAM)
      } catch {
        void this.finishAsr(s)
      }
    }
  }

  private async finishAsr(s: AsrState): Promise<void> {
    if (s.finished) return
    s.finished = true
    const text = s.assembler.finalText()
    this.broadcast({ t: 'asr.final', text })
    if (text) await this.sayFromGlasses(text)
  }
}
