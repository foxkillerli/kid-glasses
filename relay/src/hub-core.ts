import { AsrTurn, realTimers, type AsrConnector, type AsrLimits, type AsrSocket, type Timers } from './asr-turn'
import type { AsrLang } from './deepgram'
import { checkDeviceToken, isAuthedAttachment, type SocketAttachment } from './device-auth'
import type { FastLane } from './fast-lane'
import type { KidWebhook } from './kid-webhook'
import { errorName } from './log'
import { PAIR_CODE_RE, PAIR_ID_RE, type Pairing } from './pairing'
import { HistoryStore, PAGE_MAX, type HistoryItem, type KvStorage } from './history'
import { MAX_SAY_CHARS, parseClientMessage, type ServerMessage, type WireItem } from './protocol'
import { MAX_OUTGOING_CHARS, clip, cleanText, fromSlack, isFromGlasses, toSlack } from './sanitize'
import type { KidMessage } from './slack-events'
import { ChannelNotAllowedError, SlackApiError, SlackConfigError, slackErrorIsUncertain, type PostResult } from './slack-client'

export interface DeviceSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

export type { AsrSocket, Timers }

export interface HubDeps {
  storage: KvStorage
  sockets: () => DeviceSocket[]
  deviceToken?: string
  slack: {
    postToKid(text: string, threadTs: string | null): Promise<PostResult>
    selfUserId(): Promise<string | null>
    findOwnPost?(text: string, threadTs: string | null, sinceMs: number, excludeTs?: Set<string>): Promise<PostResult | null>
  }
  asr: AsrConnector | null
  timers?: Timers
  asrLimits?: Partial<AsrLimits>
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
export const CID_CAP = 1000
export const CID_HARD_CAP = 5000
export const CID_PROTECT_MS = 13 * 60 * 60 * 1000
export const CID_TTL_MS = 24 * 60 * 60 * 1000
export const PENDING_AUDIO_CAP = 100
export const VOICE_PENDING_KEY = 'meta:voice-pending'
export const VOICE_PENDING_CAP = 20
export const VOICE_PENDING_TTL_MS = 12 * 60 * 60 * 1000
export const RECONCILE_SETTLE_MS = 30_000
const RECONCILE_HISTORY_PAGES = 4
export const CLOSE_UNAUTHORIZED = 4401
export const CLOSE_NOT_CONFIGURED = 4503

interface VoiceTurn {
  asr: AsrTurn
  cid: string | undefined
  owner: DeviceSocket
}

interface PendingVoice {
  cid: string
  text: string
  at: number
  session?: string
  threadTs?: string | null
}

function fitUtf16(s: string, max: number): string {
  if (s.length <= max) return s
  const chars = Array.from(s)
  while (chars.join('').length > max) chars.pop()
  return chars.join('')
}

interface CidEntry {
  cid: string
  seq?: number
  at: number
  state: 'sending' | 'uncertain' | 'posted'
  threadTs?: string | null
  session?: string
  slackTs?: string
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
  private turn: VoiceTurn | null = null
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
    return ((await this.deps.storage.get<CidEntry[]>(CIDS_KEY)) ?? []).filter(c => now - c.at < CID_TTL_MS).map(c => ({ ...c, state: c.state ?? 'posted' }))
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
      if (!this.turn || this.turn.owner === ws) this.onAudioFrame(data)
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
        if (m.lastSeq !== undefined) {
          await this.replay(ws, m.lastSeq, lastSeq)
          this.send(ws, { t: 'replay.done', upTo: lastSeq })
        }
        for (const p of await this.pendingVoice()) this.send(ws, { t: 'turn.pending', cid: p.cid, text: p.text })
        return
      }
      case 'ping':
        this.send(ws, { t: 'pong' })
        return
      case 'say':
        await this.sayFromGlasses(m.text, m.cid)
        return
      case 'audio.start':
        await this.startAsr(ws, m.cid, m.lang)
        return
      case 'audio.stop':
        if (this.turn && this.turn.owner !== ws) return
        this.stopAsr('device')
        return
      case 'audio.cancel':
        if (this.turn && this.turn.owner !== ws) return
        this.cancelAsr('device')
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

  sayFromGlasses(raw: string, cid?: string, voice = false): Promise<HistoryItem | null> {
    return this.enqueue(() => this.postNow(raw, cid, voice))
  }

  private async pendingVoice(): Promise<PendingVoice[]> {
    const now = this.deps.now()
    return ((await this.deps.storage.get<PendingVoice[]>(VOICE_PENDING_KEY)) ?? []).filter(p => now - p.at < VOICE_PENDING_TTL_MS)
  }

  private async keepPendingVoice(cid: string, raw: string, target: Session): Promise<void> {
    const text = fitUtf16(clip(cleanText(raw), MAX_SAY_CHARS), MAX_SAY_CHARS)
    if (!text) return
    const prior = (await this.pendingVoice()).find(p => p.cid === cid)
    const entry: PendingVoice = prior ? { ...prior, text } : { cid, text, at: this.deps.now(), session: target.id, threadTs: target.threadTs }
    const list = [...(await this.pendingVoice()).filter(p => p.cid !== cid), entry].slice(-VOICE_PENDING_CAP)
    await this.deps.storage.put(VOICE_PENDING_KEY, list)
    this.log(`voice pending kept n=${list.length}`)
    this.broadcast({ t: 'turn.pending', cid, text })
  }

  private async dropPendingVoice(cid: string | undefined): Promise<void> {
    if (!cid) return
    const all = (await this.deps.storage.get<PendingVoice[]>(VOICE_PENDING_KEY)) ?? []
    if (!all.some(p => p.cid === cid)) return
    await this.deps.storage.put(VOICE_PENDING_KEY, (await this.pendingVoice()).filter(p => p.cid !== cid))
    this.log('voice pending cleared')
  }

  private async recentGlassesTs(cid: string): Promise<string[]> {
    const out: string[] = []
    let before: number | null = null
    for (let i = 0; i < RECONCILE_HISTORY_PAGES; i++) {
      const page = await this.history.page(before, PAGE_MAX)
      for (const item of page.items) if (item.from === 'glasses' && item.slackTs && item.cid !== cid) out.push(item.slackTs)
      if (!page.more || !page.items.length) break
      before = page.items[0].seq
    }
    return out
  }

  private trimCids(list: CidEntry[]): CidEntry[] {
    if (list.length <= CID_CAP) return list
    const now = this.deps.now()
    const cut = list.length - CID_CAP
    return list.filter((c, i) => i >= cut || now - c.at < CID_PROTECT_MS).slice(-CID_HARD_CAP)
  }

  private async putCids(list: CidEntry[]): Promise<void> {
    await this.deps.storage.put(CIDS_KEY, this.trimCids(list))
  }

  private async postNow(raw: string, cid?: string, voice = false): Promise<HistoryItem | null> {
    const cids = cid ? await this.liveCids() : []
    const known = cid ? cids.find(c => c.cid === cid) : undefined
    const others = cids.filter(c => c !== known)
    if (cid && known?.state === 'posted' && known.seq !== undefined) {
      const prior = await this.history.get(known.seq)
      this.log(`say duplicate cid seq=${known.seq}`)
      await this.dropPendingVoice(cid)
      this.broadcast({ t: 'posted', seq: known.seq, text: prior?.text ?? '', cid, dup: true })
      return prior ?? null
    }
    const slackText = toSlack(raw)
    if (!slackText) {
      this.broadcast({ t: 'error', code: 'empty-text', message: 'nothing to send', ...(cid ? { cid } : {}) })
      return null
    }
    const current = await this.currentSession()
    const pv = cid ? (await this.pendingVoice()).find(p => p.cid === cid) : undefined
    const session: Session = pv?.session && pv.session !== current.id ? { id: pv.session, threadTs: pv.threadTs ?? null, startedAt: pv.at, lastAt: pv.at } : current
    if (cid && known) {
      const find = this.deps.slack.findOwnPost
      let found: PostResult | null = null
      try {
        if (!find) throw new Error('no reconcile')
        const taken = new Set([...others.map(c => c.slackTs).filter((t): t is string => !!t), ...(await this.recentGlassesTs(cid))])
        found = await find.call(this.deps.slack, slackText, known.threadTs ?? null, known.at, taken)
      } catch (err) {
        this.log(`say reconcile failed ${errorName(err)}`)
        this.broadcast({ t: 'error', code: 'slack-unreachable', message: 'could not check whether the last attempt reached Slack', cid })
        return null
      }
      if (found) {
        this.log('say reconciled: earlier attempt had reached Slack')
        const origin: Session = known.session && known.session !== current.id ? { id: known.session, threadTs: known.threadTs ?? null, startedAt: known.at, lastAt: known.at } : current
        return this.recordPosted(raw, cid, others, origin, known.threadTs ?? null, found, true)
      }
      if (this.deps.now() - known.at < RECONCILE_SETTLE_MS) {
        this.log('say reconcile not settled; retry later')
        this.broadcast({ t: 'error', code: 'slack-unreachable', message: 'the last attempt may still reach Slack; retry later', cid })
        return null
      }
    }
    if (cid) await this.putCids([...others, { cid, state: 'sending', at: this.deps.now(), threadTs: session.threadTs, session: session.id }])
    let posted: PostResult
    try {
      posted = await this.deps.slack.postToKid(slackText, session.threadTs)
    } catch (err) {
      const e = err as Error
      this.log(`slack post failed ${errorName(e)}`)
      const definite = e instanceof ChannelNotAllowedError || e instanceof SlackConfigError || (e instanceof SlackApiError && !slackErrorIsUncertain(e.code))
      if (cid) await this.putCids(definite ? others : [...others, { cid, state: 'uncertain', at: this.deps.now(), threadTs: session.threadTs, session: session.id }])
      this.broadcast({ t: 'error', code: definite ? e.name : 'slack-unreachable', message: definite ? e.message : 'could not reach Slack', ...(cid ? { cid } : {}) })
      const permanent = e instanceof ChannelNotAllowedError || e instanceof SlackConfigError
      if (permanent) await this.dropPendingVoice(cid)
      else if (cid && (voice || pv)) await this.keepPendingVoice(cid, raw, session)
      return null
    }
    return this.recordPosted(raw, cid, others, session, session.threadTs, posted, false)
  }

  private async recordPosted(
    raw: string,
    cid: string | undefined,
    others: CidEntry[],
    session: Session,
    postedThreadTs: string | null,
    posted: PostResult,
    reconciled: boolean,
  ): Promise<HistoryItem> {
    await this.dropPendingVoice(cid)
    const current = await this.deps.storage.get<Session>(SESSION_KEY)
    const sameSession = current?.id === session.id
    const threadTs = postedThreadTs ?? posted.ts
    const base = sameSession && current ? current : session
    const next: Session = { ...base, threadTs: base.threadTs ?? threadTs, lastAt: this.deps.now() }
    const sessionWrites: Record<string, unknown> = {}
    if (sameSession) sessionWrites[SESSION_KEY] = next
    if (!postedThreadTs) sessionWrites[THREAD_PREFIX + threadTs] = session.id
    if (Object.keys(sessionWrites).length) await this.deps.storage.putAll(sessionWrites)
    const item = await this.history.append(
      {
        from: 'glasses',
        text: cleanText(raw),
        slackTs: posted.ts,
        threadTs,
        session: session.id,
        ...(cid ? { cid } : {}),
        at: this.deps.now(),
      },
      (seq: number): Record<string, unknown> => (cid ? { [CIDS_KEY]: this.trimCids([...others, { cid, seq, at: this.deps.now(), state: 'posted' as const, slackTs: posted.ts }]) } : {}),
    )
    this.log(`say posted seq=${item.seq} len=${item.text.length}${cid ? ' cid' : ''}${reconciled ? ' reconciled' : ''}`)
    this.broadcast({ t: 'posted', seq: item.seq, text: item.text, ...(cid ? { cid } : {}), ...(reconciled ? { dup: true } : {}) })
    await this.notifyKid({ ...next, id: session.id, threadTs }, posted, item)
    if (this.deps.fastLane.enabled) {
      const answer = await this.deps.fastLane.answer(item.text)
      if (answer) {
        const fast = await this.history.append({ from: 'fast', text: cleanText(answer), slackTs: null, threadTs, session: session.id, at: this.deps.now() })
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
      if (r.status === 'paired') {
        const closed = this.closeDevices(new Set(r.evicted), 'evicted')
        this.log(`pair paired id=${r.deviceId} evicted=${r.evicted.length} sockets=${closed}`)
        return { status: 200, body: { status: 'paired', token: r.token, deviceId: r.deviceId } }
      }
      return { status: r.status === 'rate-limited' ? 429 : 200, body: r }
    }
    if (path === '/pair-confirm' || path === '/pair-revoke') {
      const user = typeof body?.user === 'string' ? body.user : ''
      const eventId = typeof body?.eventId === 'string' ? body.eventId : ''
      const atMs = typeof body?.atMs === 'number' && Number.isFinite(body.atMs) ? body.atMs : NaN
      if (!eventId || !Number.isFinite(atMs)) return { status: 200, body: { ok: false } }
      const fox = await this.deps.slack.selfUserId()
      if (!fox || user !== fox) {
        this.log(`pair command rejected reason=${fox ? 'not-fox' : 'self-unknown'}`)
        return { status: 200, body: { ok: false } }
      }
      if (path === '/pair-revoke') {
        const r = await pairing.revokeAll({ eventId, atMs })
        if (!r.ok) {
          this.log(`pair revoke skipped reason=${r.reason}`)
          return { status: 200, body: r }
        }
        const closed = this.closeDevices(new Set(r.revoked), 'revoked')
        this.log(`pair revoke devices=${r.revoked.length} sockets=${closed}`)
        return { status: 200, body: { ok: true, revoked: r.revoked.length } }
      }
      const code = typeof body?.code === 'string' && PAIR_CODE_RE.test(body.code) ? body.code : null
      if (!code) return { status: 200, body: { ok: false } }
      const r = await pairing.confirm(code, { eventId, atMs })
      this.log(`pair confirm ${r.ok ? 'ok' : `rejected reason=${r.reason}`}`)
      return { status: 200, body: r }
    }
    return null
  }

  private closeDevices(ids: Set<string>, reason: string): number {
    if (!ids.size) return 0
    let closed = 0
    for (const ws of this.deps.sockets()) {
      try {
        const a = ws.deserializeAttachment() as DeviceAttachment | null
        if (a?.deviceId && ids.has(a.deviceId)) {
          ws.serializeAttachment({ ...a, authed: false })
          ws.close(CLOSE_UNAUTHORIZED, reason)
          closed++
        }
      } catch {
        continue
      }
    }
    return closed
  }

  get recording(): boolean {
    return !!this.turn && !this.turn.asr.finished && !this.turn.asr.stopping
  }

  async startAsr(ws: DeviceSocket, cid?: string, lang: AsrLang = 'auto'): Promise<void> {
    const connector = this.deps.asr
    if (!connector) {
      this.send(ws, { t: 'error', code: 'asr-not-configured', message: 'DEEPGRAM_API_KEY is not set' })
      return
    }
    if (this.recording) {
      this.send(ws, { t: 'error', code: 'asr-busy', message: 'another device is talking', ...(cid ? { cid } : {}) })
      return
    }
    let resolve: (text: string | null) => void = () => {}
    const result = new Promise<string | null>(r => (resolve = r))
    const withCid = cid ? { cid } : {}
    const entry = { cid, owner: ws } as VoiceTurn
    entry.asr = new AsrTurn({
      connector,
      lang,
      timers: this.deps.timers ?? realTimers,
      now: this.deps.now,
      limits: this.deps.asrLimits,
      log: m => this.log(m),
      onPartial: text => this.broadcast({ t: 'asr.partial', text, ...withCid }),
      onDone: o => {
        if (this.turn === entry) this.turn = null
        if (!o.ok) {
          if (o.code) this.broadcast({ t: 'error', code: o.code, message: o.message, ...withCid })
          resolve(null)
          return
        }
        this.broadcast({ t: 'asr.final', text: o.text, ...withCid })
        if (!o.text) this.broadcast({ t: 'error', code: 'asr-empty', message: 'no speech recognised; nothing was sent', ...withCid })
        resolve(o.text || null)
      },
    })
    this.turn = entry
    this.turnChain = this.turnChain.then(() => result).then(text => (text ? this.sayFromGlasses(text, cid, true) : null)).catch(() => null)
    this.log(`asr start lang=${lang}`)
    await entry.asr.start()
  }

  onAudioFrame(frame: ArrayBuffer | ArrayBufferView): void {
    this.turn?.asr.push(frame)
  }

  cancelAsr(reason: string): void {
    const t = this.turn
    if (!t || t.asr.finished || t.asr.stopping) return
    t.asr.cancel(reason)
  }

  stopAsr(reason: string): void {
    this.turn?.asr.stop(reason)
  }

  onDeviceGone(ws: DeviceSocket): void {
    if (this.turn && this.turn.owner === ws) this.cancelAsr('owner-gone')
  }

  get turnsSettled(): Promise<unknown> {
    return this.turnChain
  }
}
