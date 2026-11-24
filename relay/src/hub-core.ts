import { CLOSE_STREAM, TranscriptAssembler, parseDeepgramMessage } from './deepgram'
import { checkDeviceToken, isAuthedAttachment, type SocketAttachment } from './device-auth'
import type { FastLane } from './fast-lane'
import { HistoryStore, PAGE_MAX, type HistoryItem, type KvStorage } from './history'
import { parseClientMessage, type ServerMessage } from './protocol'
import { cleanText, fromSlack, isFromGlasses, toSlack } from './sanitize'
import type { KidMessage } from './slack-events'
import type { PostResult } from './slack-client'

export interface DeviceSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

export interface AsrSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number }) => void): void
}

export interface HubDeps {
  storage: KvStorage
  sockets: () => DeviceSocket[]
  deviceToken?: string
  slack: { postToKid(text: string, threadTs: string | null): Promise<PostResult>; selfUserId(): Promise<string | null> }
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
export const THREAD_PREFIX = 'thread:'
export const DELIVERED_PREFIX = 'delivered:'
export const EDITED_MARK = '（已修改）'
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SEEN_CAP = 200
export const PENDING_AUDIO_CAP = 100
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_NOT_CONFIGURED = 4503

interface AsrTurn {
  socket: AsrSocket | null
  assembler: TranscriptAssembler
  pending: Array<ArrayBuffer | ArrayBufferView>
  stopRequested: boolean
  finished: boolean
  resolve: (text: string | null) => void
}

export function isAuthed(ws: DeviceSocket): boolean {
  try {
    return isAuthedAttachment(ws.deserializeAttachment())
  } catch {
    return false
  }
}

export class HubCore {
  readonly history: HistoryStore
  private turn: AsrTurn | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private kidQueue: Promise<unknown> = Promise.resolve()
  private readonly kidSendersLogged = new Set<string>()
  private turnChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: HubDeps) {
    this.history = new HistoryStore(deps.storage)
  }

  private log(m: string): void {
    this.deps.log?.(m)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => null)
    return run
  }

  send(ws: DeviceSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch (err) {
      this.log(`send failed ${String(err)}`)
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.deps.sockets()) if (isAuthed(ws)) this.send(ws, msg)
  }

  private toWire(i: HistoryItem) {
    return { seq: i.seq, from: i.from, text: i.text, at: i.at, session: i.session ?? null, ...(i.edited ? { edited: true } : {}) }
  }

  private async sessionForThread(threadTs: string | null): Promise<string | null> {
    if (threadTs) {
      const id = await this.deps.storage.get<string>(THREAD_PREFIX + threadTs)
      if (id) return id
    }
    const s = await this.deps.storage.get<Session>(SESSION_KEY)
    return this.isLive(s, this.deps.now()) ? s.id : null
  }

  private isLive(s: Session | undefined, now: number): s is Session {
    return !!s && now - s.lastAt < SESSION_IDLE_MS
  }

  private async currentSession(forceNew = false): Promise<Session> {
    const now = this.deps.now()
    const s = await this.deps.storage.get<Session>(SESSION_KEY)
    if (!forceNew && this.isLive(s, now)) return s
    const fresh: Session = { id: `s${now.toString(36)}`, threadTs: null, startedAt: now, lastAt: now }
    await this.deps.storage.put(SESSION_KEY, fresh)
    return fresh
  }

  private rejectUnauthed(ws: DeviceSocket, code: number, reason: string): void {
    this.send(ws, { t: 'error', code: reason, message: 'authenticate first with {"t":"auth","token":…}' })
    try {
      ws.close(code, reason)
    } catch {
      return
    }
  }

  async onDeviceMessage(ws: DeviceSocket, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (!isAuthed(ws)) {
      await this.authenticate(ws, data)
      return
    }
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
      case 'auth':
        this.send(ws, { t: 'auth.ok' })
        return
      case 'hello': {
        const session = await this.enqueue(() => this.currentSession())
        const lastSeq = await this.history.lastSeq()
        this.send(ws, { t: 'hello', session: session.id, lastSeq, fastLane: this.deps.fastLane.enabled })
        if (m.lastSeq !== undefined) await this.replay(ws, m.lastSeq, lastSeq)
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
        await this.enqueue(() => this.currentSession(true))
        return
    }
  }

  private async authenticate(ws: DeviceSocket, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const parsed = typeof data === 'string' ? parseClientMessage(data) : null
    if (!parsed?.ok || parsed.msg.t !== 'auth') return this.rejectUnauthed(ws, CLOSE_UNAUTHORIZED, 'unauthorized')
    const verdict = checkDeviceToken(parsed.msg.token, this.deps.deviceToken)
    if (verdict === 'not-configured') return this.rejectUnauthed(ws, CLOSE_NOT_CONFIGURED, 'device-token-not-configured')
    if (verdict !== 'ok') return this.rejectUnauthed(ws, CLOSE_UNAUTHORIZED, 'unauthorized')
    const attachment: SocketAttachment = { authed: true, connectedAt: this.deps.now() }
    ws.serializeAttachment(attachment)
    this.send(ws, { t: 'auth.ok' })
  }

  private async replay(ws: DeviceSocket, afterSeq: number, upTo: number): Promise<void> {
    let cursor = afterSeq
    while (cursor < upTo) {
      const batch = await this.history.since(cursor, PAGE_MAX)
      if (batch.length === 0) break
      for (const i of batch) if (i.seq <= upTo) this.send(ws, { t: 'msg', ...this.toWire(i) })
      cursor = batch[batch.length - 1].seq
    }
  }

  sayFromGlasses(raw: string): Promise<HistoryItem | null> {
    return this.enqueue(() => this.postNow(raw))
  }

  private async postNow(raw: string): Promise<HistoryItem | null> {
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
      this.log(`slack post failed ${e.name}`)
      this.broadcast({ t: 'error', code: e.name || 'slack-error', message: e.message })
      return null
    }
    const next: Session = { ...session, threadTs: session.threadTs ?? posted.ts, lastAt: this.deps.now() }
    const sessionWrites: Record<string, unknown> = { [SESSION_KEY]: next }
    if (!session.threadTs && next.threadTs) sessionWrites[THREAD_PREFIX + next.threadTs] = next.id
    await this.deps.storage.putAll(sessionWrites)
    const item = await this.history.append({
      from: 'glasses',
      text: cleanText(raw),
      slackTs: posted.ts,
      threadTs: next.threadTs,
      session: next.id,
      at: this.deps.now(),
    })
    this.broadcast({ t: 'posted', seq: item.seq, text: item.text })
    if (this.deps.fastLane.enabled) {
      const answer = await this.deps.fastLane.answer(item.text)
      if (answer) {
        const fast = await this.history.append({ from: 'fast', text: cleanText(answer), slackTs: null, threadTs: next.threadTs, session: next.id, at: this.deps.now() })
        this.broadcast({ t: 'msg', ...this.toWire(fast) })
      }
    }
    return item
  }

  onKidMessage(msg: KidMessage): Promise<HistoryItem | null> {
    const run = this.kidQueue.then(() => this.handleKidMessage(msg))
    this.kidQueue = run.catch(() => null)
    return run
  }

  private async handleKidMessage(msg: KidMessage): Promise<HistoryItem | null> {
    const seen = (await this.deps.storage.get<string[]>(SEEN_KEY)) ?? []
    if (seen.includes(msg.eventId)) return null
    const nextSeen = [...seen, msg.eventId].slice(-SEEN_CAP)
    const self = msg.user ? await this.deps.slack.selfUserId() : null
    const body = fromSlack(msg.text)
    const echo = !msg.verifiedKid && isFromGlasses(msg.text.trimStart())
    const deliveredKey = DELIVERED_PREFIX + msg.ts
    const unchangedEdit = msg.kind === 'edit' && (await this.deps.storage.get<string>(deliveredKey)) === body
    if ((self && msg.user === self) || echo || !body || unchangedEdit) {
      await this.deps.storage.put(SEEN_KEY, nextSeen)
      return null
    }
    const sender = `user=${msg.user ?? '-'} bot=${msg.botId ?? '-'}`
    if (!this.kidSendersLogged.has(sender)) {
      this.kidSendersLogged.add(sender)
      this.log(`kid sender ${sender}`)
    }
    const edited = msg.kind === 'edit'
    const session = await this.sessionForThread(msg.threadTs)
    const item = await this.history.append(
      { from: 'kid', text: edited ? EDITED_MARK + body : body, slackTs: msg.ts, threadTs: msg.threadTs, session, ...(edited ? { edited: true } : {}), at: this.deps.now() },
      { [SEEN_KEY]: nextSeen, [deliveredKey]: body },
    )
    this.broadcast({ t: 'msg', ...this.toWire(item) })
    if (session) {
      void this.enqueue(async () => {
        const now = this.deps.now()
        const s = await this.deps.storage.get<Session>(SESSION_KEY)
        if (this.isLive(s, now) && s.id === session) await this.deps.storage.put(SESSION_KEY, { ...s, lastAt: now })
      })
    }
    return item
  }

  get recording(): boolean {
    return !!this.turn && !this.turn.finished && !this.turn.stopRequested
  }

  async startAsr(ws: DeviceSocket): Promise<void> {
    if (!this.deps.asr) {
      this.send(ws, { t: 'error', code: 'asr-not-configured', message: 'DEEPGRAM_API_KEY is not set' })
      return
    }
    if (this.recording) return
    let resolve: (text: string | null) => void = () => {}
    const result = new Promise<string | null>(r => (resolve = r))
    const turn: AsrTurn = { socket: null, assembler: new TranscriptAssembler(), pending: [], stopRequested: false, finished: false, resolve }
    this.turn = turn
    this.turnChain = this.turnChain.then(() => result).then(text => (text ? this.sayFromGlasses(text) : null)).catch(() => null)
    let socket: AsrSocket
    try {
      socket = await this.deps.asr.connect()
    } catch (err) {
      turn.finished = true
      if (this.turn === turn) this.turn = null
      turn.resolve(null)
      this.broadcast({ t: 'error', code: 'asr-connect-failed', message: String(err) })
      return
    }
    turn.socket = socket
    socket.addEventListener('message', ev => {
      if (typeof ev.data !== 'string' || turn.finished) return
      const r = parseDeepgramMessage(ev.data)
      if (!r) return
      const { partial } = turn.assembler.feed(r)
      if (partial) this.broadcast({ t: 'asr.partial', text: partial })
    })
    socket.addEventListener('close', ev => {
      this.finishAsr(turn, turn.stopRequested && ev.code === 1000)
    })
    socket.addEventListener('error', () => {
      this.finishAsr(turn, false)
    })
    for (const frame of turn.pending) socket.send(frame)
    turn.pending = []
    if (turn.stopRequested) socket.send(CLOSE_STREAM)
  }

  onAudioFrame(frame: ArrayBuffer | ArrayBufferView): void {
    const t = this.turn
    if (!t || t.finished || t.stopRequested) return
    if (t.socket) t.socket.send(frame)
    else if (t.pending.length < PENDING_AUDIO_CAP) t.pending.push(frame)
  }

  stopAsr(reason: string): void {
    const t = this.turn
    if (!t || t.finished || t.stopRequested) return
    t.stopRequested = true
    this.log(`asr stop (${reason})`)
    if (t.socket) {
      try {
        t.socket.send(CLOSE_STREAM)
      } catch {
        this.finishAsr(t, false)
      }
    }
  }

  get turnsSettled(): Promise<unknown> {
    return this.turnChain
  }

  private finishAsr(t: AsrTurn, completed: boolean): void {
    if (t.finished) return
    t.finished = true
    if (this.turn === t) this.turn = null
    const text = t.assembler.finalText()
    if (!completed) {
      this.broadcast({ t: 'error', code: 'asr-interrupted', message: 'transcription ended early; nothing was sent' })
      t.resolve(null)
      return
    }
    this.broadcast({ t: 'asr.final', text })
    t.resolve(text || null)
  }
}
