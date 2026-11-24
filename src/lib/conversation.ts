import { LENS_TEXT, fitsLensLine, wrapForLens } from './lens-text'
import { paginateLines } from './paginate'
import type { OutboxEntry, RelayItem } from './relay-client'

export const KEEP_ITEMS = 40
export const PREFIX = { kid: 'Kid：', glasses: '我：', fast: '快答：', pending: '我（待发）：' } as const

export function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (fitsLensLine(flat)) return flat
  const chars = Array.from(flat)
  let n = chars.length
  while (n > 0 && !fitsLensLine(chars.slice(0, n).join('') + '…')) n--
  return chars.slice(0, n).join('') + '…'
}

interface Block {
  key: string
  lines: string[]
}

export class Conversation {
  private readonly items = new Map<number, RelayItem>()
  private pendingEntries: OutboxEntry[] = []
  private pageIndex = 0
  private follow = true

  constructor(private readonly bodyLines: number = LENS_TEXT.bodyLines) {}

  get size(): number {
    return this.items.size + this.pendingEntries.length
  }

  upsert(list: RelayItem[], kind: 'live' | 'replay' | 'history'): RelayItem | null {
    let newestKid: RelayItem | null = null
    for (const i of list) {
      const known = this.items.get(i.seq)
      this.items.set(i.seq, { ...known, ...i })
      if (!known && i.from !== 'glasses' && (!newestKid || i.seq > newestKid.seq)) newestKid = i
    }
    const seqs = [...this.items.keys()].sort((a, b) => a - b)
    for (const s of seqs.slice(0, Math.max(0, seqs.length - KEEP_ITEMS))) this.items.delete(s)
    if (kind !== 'history' && newestKid && this.items.has(newestKid.seq)) this.jumpTo(`s${newestKid.seq}`)
    else if (this.follow) this.pageIndex = this.pages().length - 1
    return kind === 'history' ? null : newestKid
  }

  setPending(entries: OutboxEntry[]): void {
    const posted = new Set([...this.items.values()].map(i => i.cid).filter(Boolean))
    this.pendingEntries = entries.filter(e => !posted.has(e.cid))
    if (this.follow) this.pageIndex = this.pages().length - 1
  }

  private blocks(): Block[] {
    const out: Block[] = []
    for (const i of [...this.items.values()].sort((a, b) => a.seq - b.seq)) {
      if (i.from === 'glasses') out.push({ key: `s${i.seq}`, lines: [oneLine(PREFIX.glasses + i.text)] })
      else out.push({ key: `s${i.seq}`, lines: wrapForLens((i.from === 'kid' ? PREFIX.kid : PREFIX.fast) + i.text) })
    }
    for (const e of this.pendingEntries) out.push({ key: `c${e.cid}`, lines: [oneLine(PREFIX.pending + e.text)] })
    return out
  }

  private layout(): { pages: string[][]; starts: Map<string, number> } {
    const lines: string[] = []
    const startLine = new Map<string, number>()
    for (const b of this.blocks()) {
      startLine.set(b.key, lines.length)
      lines.push(...b.lines)
    }
    const pages = lines.length ? paginateLines(lines, { maxLines: this.bodyLines, maxBytes: LENS_TEXT.pageMaxBytes }) : []
    const starts = new Map<string, number>()
    let cursor = 0
    const pageOfLine: number[] = []
    pages.forEach((p, pi) => {
      for (let k = 0; k < p.length; k++) pageOfLine[cursor + k] = pi
      cursor += p.length
    })
    for (const [k, l] of startLine) starts.set(k, pageOfLine[l] ?? Math.max(0, pages.length - 1))
    return { pages, starts }
  }

  pages(): string[][] {
    return this.layout().pages
  }

  private jumpTo(key: string): void {
    const { pages, starts } = this.layout()
    this.pageIndex = starts.get(key) ?? Math.max(0, pages.length - 1)
    this.follow = this.pageIndex >= pages.length - 1
  }

  next(): void {
    const n = this.pages().length
    this.pageIndex = Math.min(Math.max(0, n - 1), this.pageIndex + 1)
    this.follow = this.pageIndex >= n - 1
  }

  prev(): void {
    this.pageIndex = Math.max(0, this.pageIndex - 1)
    this.follow = this.pageIndex >= this.pages().length - 1
  }

  view(): { body: string; page: number; pages: number } {
    const pages = this.pages()
    if (!pages.length) return { body: '', page: 0, pages: 0 }
    const page = Math.min(this.pageIndex, pages.length - 1)
    return { body: pages[page].join('\n'), page: page + 1, pages: pages.length }
  }
}
