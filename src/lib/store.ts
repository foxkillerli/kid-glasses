export interface AsyncStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface BridgeStorage {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}

export interface SyncKV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export class MemoryStore implements AsyncStore {
  readonly map = new Map<string, string>()
  async get(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  async set(key: string, value: string) {
    this.map.set(key, value)
  }
  async remove(key: string) {
    this.map.delete(key)
  }
}

export class BridgeStore implements AsyncStore {
  private bridgeOk = true

  constructor(
    private readonly bridge: Partial<BridgeStorage>,
    private readonly fallback: SyncKV | null,
  ) {}

  async get(key: string): Promise<string | null> {
    if (this.bridgeOk && this.bridge.getLocalStorage) {
      try {
        const v = await this.bridge.getLocalStorage(key)
        if (typeof v === 'string' && v !== '') return v
        return this.fallback?.getItem(key) || null
      } catch {
        this.bridgeOk = false
      }
    }
    return this.fallback?.getItem(key) ?? null
  }

  async set(key: string, value: string): Promise<void> {
    if (this.bridgeOk && this.bridge.setLocalStorage) {
      try {
        if (await this.bridge.setLocalStorage(key, value)) return
      } catch {
        this.bridgeOk = false
      }
    }
    this.fallback?.setItem(key, value)
  }

  async remove(key: string): Promise<void> {
    await this.set(key, '')
    this.fallback?.removeItem?.(key)
  }
}
