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
  close(code = 1000): void {
    this.emit('close', { code })
  }
  addEventListener(type: 'message' | 'close' | 'error', listener: (ev: { data?: unknown; code?: number }) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }
  emit(type: string, ev: { data?: unknown; code?: number }): void {
    for (const l of this.listeners[type] ?? []) l(ev)
  }
  result(transcript: string, isFinal: boolean): void {
    this.emit('message', { data: JSON.stringify({ type: 'Results', is_final: isFinal, speech_final: isFinal, channel: { alternatives: [{ transcript }] } }) })
  }
}

export const flush = () => new Promise(r => setTimeout(r, 0))
