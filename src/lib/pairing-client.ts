import { STORE_KEYS } from './relay-config'
import type { AsyncStore } from './store'

export type PairPhase = 'idle' | 'starting' | 'waiting' | 'expired' | 'error' | 'paired'

export interface PairView {
  phase: PairPhase
  code: string | null
  expiresAt: number
  detail: string
}

interface Pending {
  pairId: string
  code: string
  expiresAt: number
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface PairingClientDeps {
  origin: string
  fetch: FetchFn
  store: AsyncStore
  now: () => number
  pollMs: number
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void }
  onView(view: PairView): void
  onToken(token: string): Promise<void>
  log?: (m: string) => void
}

export class PairingClient {
  private pending: Pending | null = null
  private timer: unknown = null
  private viewValue: PairView = { phase: 'idle', code: null, expiresAt: 0, detail: '' }
  private busy = false

  constructor(private readonly deps: PairingClientDeps) {}

  get view(): PairView {
    return this.viewValue
  }

  private set(view: Partial<PairView>) {
    this.viewValue = { ...this.viewValue, ...view }
    this.deps.onView(this.viewValue)
  }

  private post(path: string, body: string): Promise<Response> {
    return this.deps.fetch(`${this.deps.origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
  }

  async begin(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const saved = await this.deps.store.get(STORE_KEYS.pairing)
      if (saved) {
        try {
          const p = JSON.parse(saved) as Pending
          if (p && typeof p.pairId === 'string' && typeof p.code === 'string' && p.expiresAt > this.deps.now()) {
            this.pending = p
            this.set({ phase: 'waiting', code: p.code, expiresAt: p.expiresAt, detail: '' })
            this.schedule(0)
            return
          }
        } catch {
          this.deps.log?.('pairing: stale saved state dropped')
        }
      }
      await this.fresh()
    } finally {
      this.busy = false
    }
  }

  async restart(): Promise<void> {
    this.cancel()
    await this.deps.store.remove(STORE_KEYS.pairing)
    this.pending = null
    await this.begin()
  }

  cancel(): void {
    if (this.timer !== null) this.deps.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private async fresh(): Promise<void> {
    this.set({ phase: 'starting', code: null, expiresAt: 0, detail: '' })
    let res: Response
    try {
      res = await this.post('/pair/start', '')
    } catch {
      this.set({ phase: 'error', detail: '网络不通' })
      return
    }
    if (res.status === 429) {
      this.set({ phase: 'error', detail: '请求太频繁，稍后单击重试' })
      return
    }
    if (!res.ok) {
      this.set({ phase: 'error', detail: `relay ${res.status}` })
      return
    }
    const body = (await res.json().catch(() => null)) as Pending | null
    if (!body || typeof body.pairId !== 'string' || typeof body.code !== 'string') {
      this.set({ phase: 'error', detail: 'relay 回复格式不对' })
      return
    }
    this.pending = { pairId: body.pairId, code: body.code, expiresAt: Number(body.expiresAt) || this.deps.now() + 5 * 60_000 }
    await this.deps.store.set(STORE_KEYS.pairing, JSON.stringify(this.pending))
    this.set({ phase: 'waiting', code: this.pending.code, expiresAt: this.pending.expiresAt, detail: '' })
    this.schedule(this.deps.pollMs)
  }

  private schedule(ms: number): void {
    this.cancel()
    this.timer = this.deps.timers.setTimeout(() => {
      this.timer = null
      void this.poll()
    }, ms)
  }

  async poll(): Promise<void> {
    const p = this.pending
    if (!p) return
    if (p.expiresAt <= this.deps.now()) return this.expire()
    let res: Response
    try {
      res = await this.post('/pair/poll', JSON.stringify({ pairId: p.pairId }))
    } catch {
      this.set({ detail: '网络不通，正在重试' })
      return this.schedule(this.deps.pollMs * 2)
    }
    const body = (await res.json().catch(() => null)) as { status?: string; token?: string } | null
    if (res.status === 429 || body?.status === 'rate-limited') return this.schedule(this.deps.pollMs * 4)
    if (body?.status === 'paired' && typeof body.token === 'string') {
      this.pending = null
      await this.deps.store.remove(STORE_KEYS.pairing)
      this.set({ phase: 'paired', code: null, detail: '' })
      await this.deps.onToken(body.token)
      return
    }
    if (body?.status === 'expired') return this.expire()
    this.set({ detail: '' })
    this.schedule(this.deps.pollMs)
  }

  private async expire(): Promise<void> {
    this.cancel()
    this.pending = null
    await this.deps.store.remove(STORE_KEYS.pairing)
    this.set({ phase: 'expired', code: null, detail: '' })
  }
}
