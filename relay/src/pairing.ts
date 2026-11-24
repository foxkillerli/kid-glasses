import type { KvStorage } from './history'
import { timingSafeEqual } from './slack-verify'

export const PAIR_TTL_MS = 5 * 60 * 1000
export const MAX_PENDING = 5
export const MAX_DEVICES = 10
export const START_LIMIT_PER_MIN = 3
export const POLL_LIMIT_PER_MIN = 60
export const MAX_FAILED_CONFIRMS = 5
export const FAIL_WINDOW_MS = 10 * 60 * 1000
export const LOCKOUT_MS = 10 * 60 * 1000
export const DEVICE_TOKEN_PREFIX = 'kgd_'

export const PENDING_KEY = 'pair:pending'
export const DEVICES_KEY = 'pair:devices'
export const FAILS_KEY = 'pair:fails'
export const EVENTS_KEY = 'pair:events'
export const EVENTS_CAP = 200
export const MAX_PENDING_PER_CLIENT = 2
export const CONFIRM_SKEW_MS = 60_000

export interface PendingPair {
  pairId: string
  code: string
  createdAt: number
  expiresAt: number
  confirmed: boolean
  client: string
}

export interface CommandMeta {
  eventId: string
  atMs: number
}

export interface PairedDevice {
  id: string
  hash: string
  createdAt: number
}

interface FailState {
  count: number
  windowStart: number
  lockedUntil: number
}

export type StartResult = { ok: true; pairId: string; code: string; expiresAt: number } | { ok: false; error: 'rate-limited' | 'busy' }
export type PollResult =
  | { status: 'pending'; expiresAt: number }
  | { status: 'paired'; token: string; deviceId: string; evicted: string[] }
  | { status: 'expired' }
  | { status: 'rate-limited' }
export type ConfirmResult = { ok: true } | { ok: false; reason: 'locked' | 'no-match' | 'duplicate-event' }
export type RevokeResult = { ok: true; revoked: string[] } | { ok: false; reason: 'duplicate-event' }

export interface PairingDeps {
  storage: KvStorage
  now: () => number
  randomBytes?: (n: number) => Uint8Array
}

const encoder = new TextEncoder()

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(s: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(s))))
}

export const PAIR_CODE_RE = /^\d{6}$/
export const PAIR_ID_RE = /^[0-9a-f]{32}$/

export class Pairing {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly hits = new Map<string, number[]>()
  private readonly randomBytes: (n: number) => Uint8Array

  constructor(private readonly deps: PairingDeps) {
    this.randomBytes = deps.randomBytes ?? (n => crypto.getRandomValues(new Uint8Array(n)))
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => null)
    return run
  }

  private limited(bucket: string, client: string, perMinute: number): boolean {
    const now = this.deps.now()
    const key = `${bucket}:${client}`
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (recent.length >= perMinute) {
      this.hits.set(key, recent)
      return true
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 1000) {
      for (const [k, v] of this.hits) if (!v.some(t => now - t < 60_000)) this.hits.delete(k)
    }
    return false
  }

  private async pending(): Promise<PendingPair[]> {
    const now = this.deps.now()
    return ((await this.deps.storage.get<PendingPair[]>(PENDING_KEY)) ?? []).filter(p => p.expiresAt > now)
  }

  private sixDigits(): string {
    for (;;) {
      const b = this.randomBytes(4)
      const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
      if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, '0')
    }
  }

  start(client: string): Promise<StartResult> {
    return this.serial(async () => {
      if (this.limited('start', client, START_LIMIT_PER_MIN)) return { ok: false, error: 'rate-limited' }
      let list = await this.pending()
      const mine = list.filter(p => p.client === client && !p.confirmed)
      if (mine.length >= MAX_PENDING_PER_CLIENT) list = list.filter(p => p !== mine[0])
      if (list.length >= MAX_PENDING) return { ok: false, error: 'busy' }
      let code = this.sixDigits()
      while (list.some(p => p.code === code)) code = this.sixDigits()
      const now = this.deps.now()
      const entry: PendingPair = { pairId: hex(this.randomBytes(16)), code, createdAt: now, expiresAt: now + PAIR_TTL_MS, confirmed: false, client }
      await this.deps.storage.put(PENDING_KEY, [...list, entry])
      return { ok: true, pairId: entry.pairId, code: entry.code, expiresAt: entry.expiresAt }
    })
  }

  private async seenEvent(eventId: string): Promise<{ seen: boolean; next: string[] }> {
    const events = (await this.deps.storage.get<string[]>(EVENTS_KEY)) ?? []
    return { seen: events.includes(eventId), next: [...events, eventId].slice(-EVENTS_CAP) }
  }

  confirm(code: string, meta: CommandMeta): Promise<ConfirmResult> {
    return this.serial(async () => {
      const ev = await this.seenEvent(meta.eventId)
      if (ev.seen) return { ok: false, reason: 'duplicate-event' }
      const now = this.deps.now()
      const fails = (await this.deps.storage.get<FailState>(FAILS_KEY)) ?? { count: 0, windowStart: now, lockedUntil: 0 }
      if (fails.lockedUntil > now) {
        await this.deps.storage.put(EVENTS_KEY, ev.next)
        return { ok: false, reason: 'locked' }
      }
      const list = await this.pending()
      let hit: PendingPair | null = null
      for (const p of list) {
        const inWindow = meta.atMs >= p.createdAt - CONFIRM_SKEW_MS && meta.atMs <= p.expiresAt
        if (!p.confirmed && inWindow && timingSafeEqual(p.code, code) && !hit) hit = p
      }
      if (hit) {
        hit.confirmed = true
        await this.deps.storage.putAll({ [PENDING_KEY]: list, [FAILS_KEY]: { count: 0, windowStart: now, lockedUntil: 0 }, [EVENTS_KEY]: ev.next })
        return { ok: true }
      }
      const fresh = now - fails.windowStart > FAIL_WINDOW_MS ? { count: 0, windowStart: now, lockedUntil: 0 } : fails
      const next: FailState = { ...fresh, count: fresh.count + 1 }
      if (next.count >= MAX_FAILED_CONFIRMS) {
        next.lockedUntil = now + LOCKOUT_MS
        await this.deps.storage.putAll({ [FAILS_KEY]: next, [PENDING_KEY]: [], [EVENTS_KEY]: ev.next })
        return { ok: false, reason: 'locked' }
      }
      await this.deps.storage.putAll({ [FAILS_KEY]: next, [EVENTS_KEY]: ev.next })
      return { ok: false, reason: 'no-match' }
    })
  }

  poll(pairId: string, client: string): Promise<PollResult> {
    return this.serial(async () => {
      if (this.limited('poll', client, POLL_LIMIT_PER_MIN)) return { status: 'rate-limited' }
      const list = await this.pending()
      let hit: PendingPair | null = null
      for (const p of list) if (timingSafeEqual(p.pairId, pairId) && !hit) hit = p
      if (!hit) return { status: 'expired' }
      if (!hit.confirmed) return { status: 'pending', expiresAt: hit.expiresAt }
      const token = DEVICE_TOKEN_PREFIX + hex(this.randomBytes(32))
      const device: PairedDevice = { id: hex(this.randomBytes(6)), hash: await sha256Hex(token), createdAt: this.deps.now() }
      const all = [...((await this.deps.storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []), device]
      const devices = all.slice(-MAX_DEVICES)
      const evicted = all.slice(0, Math.max(0, all.length - MAX_DEVICES)).map(d => d.id)
      const remaining = list.filter(p => p !== hit)
      await this.deps.storage.putAll({ [DEVICES_KEY]: devices, [PENDING_KEY]: remaining })
      return { status: 'paired', token, deviceId: device.id, evicted }
    })
  }

  async verify(token: string): Promise<string | null> {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 128) return null
    const hash = await sha256Hex(token)
    const devices = (await this.deps.storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []
    let id: string | null = null
    for (const d of devices) if (timingSafeEqual(d.hash, hash) && !id) id = d.id
    return id
  }

  revokeAll(meta: CommandMeta): Promise<RevokeResult> {
    return this.serial(async () => {
      const ev = await this.seenEvent(meta.eventId)
      if (ev.seen) return { ok: false, reason: 'duplicate-event' }
      const devices = (await this.deps.storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []
      const pending = (await this.deps.storage.get<PendingPair[]>(PENDING_KEY)) ?? []
      const revoked = devices.filter(d => d.createdAt <= meta.atMs)
      await this.deps.storage.putAll({
        [DEVICES_KEY]: devices.filter(d => d.createdAt > meta.atMs),
        [PENDING_KEY]: pending.filter(p => p.createdAt > meta.atMs),
        [EVENTS_KEY]: ev.next,
      })
      return { ok: true, revoked: revoked.map(d => d.id) }
    })
  }

  async deviceCount(): Promise<number> {
    return ((await this.deps.storage.get<PairedDevice[]>(DEVICES_KEY)) ?? []).length
  }
}
