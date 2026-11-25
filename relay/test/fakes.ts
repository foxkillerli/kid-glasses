import type { KvStorage } from '../src/history'
import type { AsrSocket, DeviceSocket } from '../src/hub-core'

export class FakeStorage implements KvStorage {
  readonly map = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.map.get(key)) as T | undefined
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value))
  }
  failNextPutAll = false
  async putAll(entries: Record<string, unknown>): Promise<void> {
    if (this.failNextPutAll) {
      this.failNextPutAll = false
      throw new Error('storage write failed')
    }
    for (const [k, v] of Object.entries(entries)) this.map.set(k, structuredClone(v))
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
  async list<T>(o: { prefix?: string; start?: string; end?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>> {
    let keys = [...this.map.keys()].sort()
    if (o.prefix) keys = keys.filter(k => k.startsWith(o.prefix as string))
    if (o.start) keys = keys.filter(k => k >= (o.start as string))
    if (o.end) keys = keys.filter(k => k < (o.end as string))
    if (o.reverse) keys.reverse()
    if (o.limit !== undefined) keys = keys.slice(0, o.limit)
    return new Map(keys.map(k => [k, structuredClone(this.map.get(k)) as T]))
  }
}

export class FakeDevice implements DeviceSocket {
  readonly sent: Array<Record<string, unknown>> = []
  closed: { code?: number; reason?: string } | null = null
  private attachment: unknown
  constructor(authed = true) {
    this.attachment = { authed, connectedAt: 0 }
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value)
  }
  deserializeAttachment(): unknown {
    return this.attachment
  }
  of(t: string) {
    return this.sent.filter(m => m.t === t)
  }
}

export class FakeAsr implements AsrSocket {
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  private listeners: Record<string, Array<(ev: { data?: unknown; code?: number }) => void>> = {}
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data)
  }
  closedWith: number | null = null
  close(code = 1000): void {
    this.closedWith = code
    this.emit('close', { code })
  }
  addEventListener(type: 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number }) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }
  emit(type: string, ev: { data?: unknown; code?: number }): void {
    for (const l of this.listeners[type] ?? []) l(ev)
  }
  result(transcript: string, isFinal: boolean, o: { start?: number; duration?: number; fromFinalize?: boolean } = {}): void {
    this.emit('message', {
      data: JSON.stringify({
        type: 'Results',
        is_final: isFinal,
        speech_final: isFinal,
        from_finalize: !!o.fromFinalize,
        start: o.start ?? 0,
        duration: o.duration ?? 0,
        channel: { alternatives: [{ transcript }] },
      }),
    })
  }
  texts(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string')
  }
  audio(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string') as Uint8Array[]
  }
}

export class FakeTimers {
  now = 0
  private seq = 0
  private readonly due = new Map<number, { at: number; fn: () => void }>()
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.due.set(id, { at: this.now + ms, fn })
    return id
  }
  clear(h: unknown): void {
    this.due.delete(h as number)
  }
  get pending(): number {
    return this.due.size
  }
  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null
      for (const e of this.due) if (e[1].at <= end && (!next || e[1].at < next[1].at || (e[1].at === next[1].at && e[0] < next[0]))) next = e
      if (!next) break
      this.due.delete(next[0])
      this.now = next[1].at
      next[1].fn()
    }
    this.now = end
  }
}

export const flush = () => new Promise(r => setTimeout(r, 0))
