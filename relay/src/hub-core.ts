import { CLOSE_STREAM, TranscriptAssembler, parseDeepgramMessage } from './deepgram'
import { checkDeviceToken, isAuthedAttachment, type SocketAttachment } from './device-auth'
import type { FastLane } from './fast-lane'
import type { KidWebhook } from './kid-webhook'
import { errorName } from './log'
import { PAIR_CODE_RE, PAIR_ID_RE, type Pairing } from './pairing'
import { HistoryStore, PAGE_MAX, type HistoryItem, type KvStorage } from './history'
import { parseClientMessage, type ServerMessage, type WireItem } from './protocol'
import { MAX_OUTGOING_CHARS, clip, cleanText, fromSlack, isFromGlasses, toSlack } from './sanitize'
import type { KidMessage } from './slack-events'
import { ChannelNotAllowedError, SlackApiError, SlackConfigError, type PostResult } from './slack-client'

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
  kidWebhook?: KidWebhook | null
  pairing?: Pairing | null
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
export const CIDS_KEY = 'meta:cids'
export const CID_CAP = 300
export const CID_TTL_MS = 24 * 60 * 60 * 1000
export const PENDING_AUDIO_CAP = 100
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_NOT_CONFIGURED = 4503

interface AsrTurn {
  socket: AsrSocket | null
  assembler: TranscriptAssembler
  pending: Array<ArrayBuffer | ArrayBufferView>
  stopRequested: boolean
  finished: boolean
  cid: string | undefined
  resolve: (text: string | null) => void
}

interface CidEntry {
  cid: string
  seq: number
  at: number
}

export interface DeviceAttachment extends SocketAttachment {
  deviceId?: string
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
      this.log(`send failed ${errorName(err)}`)
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const ws of this.deps.sockets()) if (isAuthed(ws)) this.send(ws, msg)
  }

  private toWire(i: HistoryItem): WireItem {
    return { seq: i.seq, from: i.from, text: i.text, at: i.at, session: i.session ?? null, ...(i.edited ? { edited: true } : {}), ...(i.cid ? { cid: i.cid } : {}) }
  }

  private async liveCids(): Promise<CidEntry[]> {
    const now = this.deps.now()
    return ((await this.deps.storage.get<CidEntry[]>(CIDS_KEY)) ?? []).filter(c => now - c.at < CID_TTL_MS)
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
        await this.sayFromGlasses(m.text, m.cid)
        return
      case 'audio.start':
        await this.startAsr(ws, m.cid)
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
    const token = parsed.msg.token
    const verdict = checkDeviceToken(token, this.deps.deviceToken)
    let deviceId: string | null = null
    if (verdict !== 'ok' && this.deps.pairing) deviceId = await this.deps.pairing.verify(token)
    if (verdict !== 'ok' && !deviceId) {
      if (verdict === 'not-configured') return this.rejectUnauthed(ws, CLOSE_NOT_CONFIGURED, 'device-token-not-configured')
      this.log('device auth rejected')
      return this.rejectUnauthed(ws, CLOSE_UNAUTHORIZED, 'unauthorized')
    }
    const attachment: DeviceAttachment = { authed: true, connectedAt: this.deps.now(), ...(deviceId ? { deviceId } : {}) }
    ws.serializeAttachment(attachment)
    this.log(`device auth ok kind=${deviceId ? `paired id=${deviceId}` : 'shared'}`)
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

  sayFromGlasses(raw: string, cid?: string): Promise<HistoryItem | null> {
    return this.enqueue(() => this.postNow(raw, cid))
  }

  private async postNow(raw: string, cid?: string): Promise<HistoryItem | null> {
    const cids = cid ? await this.liveCids() : []
    const known = cid ? cids.find(c => c.cid === cid) : undefined
    if (cid && known) {
      const prior = await this.history.get(known.seq)
      this.log(`say duplicate cid seq=${known.seq}`)
      this.broadcast({ t: 'posted', seq: known.seq, text: prior?.text ?? '', cid, dup: true })
      return prior ?? null
    }
    const slackText = toSlack(raw)
    if (!slackText) {
      this.broadcast({ t: 'error', code: 'empty-text', message: 'nothing to send', ...(cid ? { cid } : {}) })
      return null
    }
    const session = await this.currentSession()
    let posted: PostResult
    try {
      posted = await this.deps.slack.postToKid(slackText, session.threadTs)
    } catch (err) {
      const e = err as Error
      this.log(`slack post failed ${errorName(e)}`)
      const known = e instanceof ChannelNotAllowedError || e instanceof SlackConfigError || e instanceof SlackApiError
      this.broadcast({ t: 'error', code: known ? e.name : 'slack-unreachable', message: known ? e.message : 'could not reach Slack', ...(cid ? { cid } : {}) })
      return null
    }
    const next: Session = { ...session, threadTs: session.threadTs ?? posted.ts, lastAt: this.deps.now() }
    const sessionWrites: Record<string, unknown> = { [SESSION_KEY]: next }
    if (!session.threadTs && next.threadTs) sessionWrites[THREAD_PREFIX + next.threadTs] = next.id
    await this.deps.storage.putAll(sessionWrites)
    const item = await this.history.append(
      {
        from: 'glasses',
        text: cleanText(raw),
        slackTs: posted.ts,
        threadTs: next.threadTs,
        session: next.id,
        ...(cid ? { cid } : {}),
        at: this.deps.now(),
      },
      (seq: number): Record<string, unknown> => (cid ? { [CIDS_KEY]: [...cids, { cid, seq, at: this.deps.now() }].slice(-CID_CAP) } : {}),
    )
    this.log(`say posted seq=${item.seq} len=${item.text.length}${cid ? ' cid' : ''}`)
    this.broadcast({ t: 'posted', seq: item.seq, text: item.text, ...(cid ? { cid } : {}) })
    await this.notifyKid(next, posted, item)
    if (this.deps.fastLane.enabled) {
      const answer = await this.deps.fastLane.answer(item.text)
      if (answer) {
        const fast = await this.history.append({ from: 'fast', text: cleanText(answer), slackTs: null, threadTs: next.threadTs, session: next.id, at: this.deps.now() })
        this.broadcast({ t: 'msg', ...this.toWire(fast) })
      }
    }
    return item
  }

  private async notifyKid(session: Session, posted: PostResult, item: HistoryItem): Promise<void> {
    const hook = this.deps.kidWebhook
    if (!hook) {
      this.broadcast({ t: 'kid-webhook', seq: item.seq, result: 'skipped', status: null })
      return
    }
    let result
    try {
      result = await hook.notify({
        v: 1,
        source: 'kid-glasses',
        session: session.id,
        channel: posted.channel,
        thread_ts: session.threadTs ?? posted.ts,
        message_ts: posted.ts,
        text: clip(item.text, MAX_OUTGOING_CHARS),
        at: this.deps.now(),
      })
    } catch {
      result = { ok: false as const, status: null, attempts: 0 }
    }
    if (result.ok) {
      this.log(`kid webhook ok status=${result.status} attempts=${result.attempts}`)
      this.broadcast({ t: 'kid-webhook', seq: item.seq, result: 'ok', status: result.status })
      return
    }
    const status = result.status === null ? 'network' : String(result.status)
    this.log(`kid webhook failed status=${status} attempts=${result.attempts}`)
    this.broadcast({ t: 'kid-webhook', seq: item.seq, result: 'failed', status: result.status })
    this.broadcast({ t: 'error', code: 'kid-webhook-failed', message: `kid webhook failed (${status})` })
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

  async pairRequest(path: string, body: Record<string, unknown> | null, client: string): Promise<{ status: number; body: unknown } | null> {
    const pairing = this.deps.pairing
    if (!pairing) return null
    if (path === '/pair/start') {
      const r = await pairing.start(client)
      this.log(`pair start ${r.ok ? 'ok' : r.error}`)
      return r.ok ? { status: 200, body: { pairId: r.pairId, code: r.code, expiresAt: r.expiresAt } } : { status: 429, body: { error: r.error } }
    }
    if (path === '/pair/poll') {
      const pairId = typeof body?.pairId === 'string' && PAIR_ID_RE.test(body.pairId) ? body.pairId : null
      if (!pairId) return { status: 400, body: { error: 'bad-request' } }
      const r = await pairing.poll(pairId, client)
      if (r.status === 'paired') this.log(`pair paired id=${r.deviceId}`)
      return { status: r.status === 'rate-limited' ? 429 : 200, body: r }
    }
    if (path === '/pair-confirm' || path === '/pair-revoke') {
      const user = typeof body?.user === 'string' ? body.user : ''
      const fox = await this.deps.slack.selfUserId()
      if (!fox || user !== fox) {
        this.log(`pair command rejected reason=${fox ? 'not-fox' : 'self-unknown'}`)
        return { status: 200, body: { ok: false } }
      }
      if (path === '/pair-revoke') {
        const n = await pairing.revokeAll()
        let closed = 0
        for (const ws of this.deps.sockets()) {
          try {
            const a = ws.deserializeAttachment() as DeviceAttachment | null
            if (a?.deviceId) {
              ws.serializeAttachment({ ...a, authed: false })
              ws.close(CLOSE_UNAUTHORIZED, 'revoked')
              closed++
            }
          } catch {
            continue
          }
        }
        this.log(`pair revoke devices=${n} sockets=${closed}`)
        return { status: 200, body: { ok: true, revoked: n } }
      }
      const code = typeof body?.code === 'string' && PAIR_CODE_RE.test(body.code) ? body.code : null
      if (!code) return { status: 200, body: { ok: false } }
      const r = await pairing.confirm(code)
      this.log(`pair confirm ${r.ok ? 'ok' : `rejected reason=${r.reason}`}`)
      return { status: 200, body: r }
    }
    return null
  }

  get recording(): boolean {
    return !!this.turn && !this.turn.finished && !this.turn.stopRequested
  }

  async startAsr(ws: DeviceSocket, cid?: string): Promise<void> {
    if (!this.deps.asr) {
      this.send(ws, { t: 'error', code: 'asr-not-configured', message: 'DEEPGRAM_API_KEY is not set' })
      return
    }
    if (this.recording) return
    let resolve: (text: string | null) => void = () => {}
    const result = new Promise<string | null>(r => (resolve = r))
    const turn: AsrTurn = { socket: null, assembler: new TranscriptAssembler(), pending: [], stopRequested: false, finished: false, cid, resolve }
    this.turn = turn
    this.turnChain = this.turnChain.then(() => result).then(text => (text ? this.sayFromGlasses(text, cid) : null)).catch(() => null)
    let socket: AsrSocket
    try {
      socket = await this.deps.asr.connect()
    } catch (err) {
      turn.finished = true
      if (this.turn === turn) this.turn = null
      turn.resolve(null)
      const message = err instanceof Error && /^deepgram upgrade failed: http \d{3}$/.test(err.message) ? err.message : 'could not reach the transcription service'
      this.log(`asr connect failed ${errorName(err)}`)
      this.broadcast({ t: 'error', code: 'asr-connect-failed', message, ...(cid ? { cid } : {}) })
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
      this.log('asr interrupted')
      this.broadcast({ t: 'error', code: 'asr-interrupted', message: 'transcription ended early; nothing was sent', ...(t.cid ? { cid: t.cid } : {}) })
      t.resolve(null)
      return
    }
    this.log(`asr final len=${text.length}`)
    this.broadcast({ t: 'asr.final', text })
    if (!text) this.broadcast({ t: 'error', code: 'asr-empty', message: 'no speech recognised; nothing was sent', ...(t.cid ? { cid: t.cid } : {}) })
    t.resolve(text || null)
  }
}
