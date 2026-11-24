export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface LogEntry {
  t: number
  b: number
  m: string
}

export class MemoryKV implements KV {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

export class RingLog {
  private entries: LogEntry[]

  constructor(
    private readonly kv: KV,
    private readonly key: string,
    readonly capacity: number,
  ) {
    if (capacity < 1) throw new Error('capacity must be >= 1')
    this.entries = RingLog.load(kv, key).slice(-capacity)
  }

  private static load(kv: KV, key: string): LogEntry[] {
    const raw = kv.getItem(key)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is LogEntry => e && typeof e.t === 'number' && typeof e.b === 'number' && typeof e.m === 'string',
      )
    } catch {
      return []
    }
  }

  add(t: number, boot: number, message: string): LogEntry {
    const entry = { t, b: boot, m: message }
    this.entries.push(entry)
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity)
    this.persist()
    return entry
  }

  all(): LogEntry[] {
    return this.entries.slice()
  }

  last(n: number): LogEntry[] {
    return n <= 0 ? [] : this.entries.slice(-n)
  }

  get size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
    this.kv.removeItem(this.key)
  }

  private persist(): void {
    try {
      this.kv.setItem(this.key, JSON.stringify(this.entries))
    } catch {
      this.entries.splice(0, Math.ceil(this.entries.length / 4))
      try {
        this.kv.setItem(this.key, JSON.stringify(this.entries))
      } catch {
        return
      }
    }
  }
}
