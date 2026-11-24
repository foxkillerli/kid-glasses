import type { Speaker } from './protocol'

export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix?: string; start?: string; end?: string; reverse?: boolean; limit?: number }): Promise<Map<string, T>>
}

export interface HistoryItem {
  seq: number
  from: Speaker
  text: string
  slackTs: string | null
  threadTs: string | null
  at: number
}

const PREFIX = 'h:'
const SEQ_KEY = 'meta:hseq'
export const HISTORY_CAP = 500
export const PAGE_MAX = 50

function key(seq: number): string {
  return PREFIX + String(seq).padStart(10, '0')
}

export class HistoryStore {
  constructor(
    private readonly storage: KvStorage,
    private readonly cap = HISTORY_CAP,
  ) {}

  async append(item: Omit<HistoryItem, 'seq'>): Promise<HistoryItem> {
    const seq = ((await this.storage.get<number>(SEQ_KEY)) ?? 0) + 1
    const full = { ...item, seq }
    await this.storage.put(key(seq), full)
    await this.storage.put(SEQ_KEY, seq)
    if (seq > this.cap) await this.storage.delete(key(seq - this.cap))
    return full
  }

  async lastSeq(): Promise<number> {
    return (await this.storage.get<number>(SEQ_KEY)) ?? 0
  }

  async page(before: number | null, limit: number): Promise<{ items: HistoryItem[]; more: boolean }> {
    const n = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit) || 1))
    const opts: { prefix: string; reverse: boolean; limit: number; end?: string } = { prefix: PREFIX, reverse: true, limit: n + 1 }
    if (before !== null) opts.end = key(before)
    const rows = [...(await this.storage.list<HistoryItem>(opts)).values()]
    const more = rows.length > n
    return { items: rows.slice(0, n).reverse(), more }
  }

  async since(afterSeq: number, limit = PAGE_MAX): Promise<HistoryItem[]> {
    const rows = await this.storage.list<HistoryItem>({ prefix: PREFIX, start: key(afterSeq + 1), limit })
    return [...rows.values()]
  }
}
