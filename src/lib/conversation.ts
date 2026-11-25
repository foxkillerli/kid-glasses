import { LENS_TEXT, fitsLensLine, wrapForLens } from './lens-text'
import { paginateLines } from './paginate'
import { PROGRESSIVE_KID_REVEAL, READING_SPEED, charsShownAfter, type ReadingSpeed } from './kid-reveal'
import type { OutboxEntry, RelayItem } from './relay-client'

export const KEEP_ITEMS = 40
export const PREFIX = { kid: 'KK：', glasses: '我：', fast: '快答：', pending: '我（待发）：', live: '你说：' } as const

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

export interface ConversationOptions {
  bodyLines?: number
  progressiveReveal?: boolean
  speed?: ReadingSpeed
  now?: () => number
}

interface Reveal {
  seq: number
  startedAt: number
}

export class Conversation {
  private readonly items = new Map<number, RelayItem>()
  private pendingEntries: OutboxEntry[] = []
  private liveText = ''
  private pageIndex = 0
  private follow = true
  private reveal: Reveal | null = null
  private readonly bodyLines: number
  private readonly progressive: boolean
  private readonly speed: ReadingSpeed
  private readonly now: () => number

  constructor(opts: ConversationOptions | number = {}) {
    const o = typeof opts === 'number' ? { bodyLines: opts } : opts
    this.bodyLines = o.bodyLines ?? LENS_TEXT.bodyLines
    this.progressive = o.progressiveReveal ?? PROGRESSIVE_KID_REVEAL
    this.speed = o.speed ?? READING_SPEED
    this.now = o.now ?? (() => Date.now())
  }

  get revealing(): boolean {
    return this.reveal !== null
  }

  private goLive(): void {
    this.follow = true
    this.pageIndex = Math.max(0, this.pages().length - 1)
  }

  private keepFollowing(): void {
    if (this.follow) this.pageIndex = Math.max(0, this.pages().length - 1)
  }

  setLive(text: string | null): void {
    const next = (text ?? '').trim()
    if (next === this.liveText) return
    const grew = next !== '' && next !== this.liveText
    this.liveText = next
    if (grew) {
      this.finishReveal()
      this.goLive()
    } else this.keepFollowing()
  }

  tick(): boolean {
    const r = this.reveal
    if (!r) return false
    const item = this.items.get(r.seq)
    if (!item || charsShownAfter(item.text, this.now() - r.startedAt, this.speed) >= Array.from(item.text).length) {
      this.reveal = null
    }
    this.keepFollowing()
    return true
  }

  skipReveal(): boolean {
    if (!this.reveal) return false
    this.reveal = null
    this.pageIndex = Math.min(this.pageIndex, Math.max(0, this.pages().length - 1))
    this.follow = this.pageIndex >= this.pages().length - 1
    return true
  }

  private finishReveal(): void {
    this.reveal = null
  }

  get size(): number {
    return this.items.size + this.pendingEntries.length
  }

  upsert(list: RelayItem[], kind: 'live' | 'replay' | 'history'): RelayItem | null {
    let newestKid: RelayItem | null = null
    let added = false
    const pendingCids = new Set(this.pendingEntries.map(e => e.cid))
    for (const i of list) {
      const known = this.items.get(i.seq)
      this.items.set(i.seq, { ...known, ...i })
      if (!known && !(i.cid && pendingCids.has(i.cid))) added = true
      if (!known && i.from !== 'glasses' && (!newestKid || i.seq > newestKid.seq)) newestKid = i
    }
    const seqs = [...this.items.keys()].sort((a, b) => a - b)
    for (const s of seqs.slice(0, Math.max(0, seqs.length - KEEP_ITEMS))) this.items.delete(s)
    if (kind === 'history') {
      this.keepFollowing()
      return null
    }
    if (newestKid && this.items.has(newestKid.seq)) {
      this.finishReveal()
      if (this.progressive && kind === 'live' && newestKid.from === 'kid') {
        this.reveal = { seq: newestKid.seq, startedAt: this.now() }
        this.goLive()
      } else this.jumpTo(`s${newestKid.seq}`)
    } else if (added) {
      this.finishReveal()
      this.goLive()
    } else this.keepFollowing()
    return newestKid
  }

  setPending(entries: OutboxEntry[]): void {
    const posted = new Set([...this.items.values()].map(i => i.cid).filter(Boolean))
    const before = new Set(this.pendingEntries.map(e => e.cid))
    this.pendingEntries = entries.filter(e => !posted.has(e.cid))
    if (this.pendingEntries.some(e => !before.has(e.cid))) {
      this.finishReveal()
      this.goLive()
    } else this.keepFollowing()
  }

  private blocks(): Block[] {
    const out: Block[] = []
    const r = this.reveal
    for (const i of [...this.items.values()].sort((a, b) => a.seq - b.seq)) {
      if (i.from === 'glasses') {
        out.push({ key: `s${i.seq}`, lines: [oneLine(PREFIX.glasses + i.text)] })
        continue
      }
      let text = i.text
      if (r && r.seq === i.seq) text = Array.from(text).slice(0, charsShownAfter(text, this.now() - r.startedAt, this.speed)).join('')
      out.push({ key: `s${i.seq}`, lines: wrapForLens((i.from === 'kid' ? PREFIX.kid : PREFIX.fast) + text) })
    }
    for (const e of this.pendingEntries) out.push({ key: `c${e.cid}`, lines: [oneLine(PREFIX.pending + e.text)] })
    if (this.liveText) out.push({ key: 'live', lines: wrapForLens(PREFIX.live + this.liveText) })
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
