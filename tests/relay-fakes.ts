import type { Timers, WsLike } from '../src/lib/relay-client'

export class FakeWs implements WsLike {
  readyState = 0
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = []
  closedWith: { code?: number; reason?: string } | null = null
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason }
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  frame(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
  json(): Array<Record<string, unknown>> {
    return this.sent.filter((d): d is string => typeof d === 'string').map(d => JSON.parse(d))
  }
  types(): string[] {
    return this.json().map(m => String(m.t))
  }
}

export class FakeTimers implements Timers {
  now = 1_000_000
  private seq = 0
  private readonly jobs = new Map<number, { at: number; fn: () => void; every: number | null }>()
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq
    this.jobs.set(id, { at: this.now + ms, fn, every: null })
    return id
  }
  clearTimeout(id: unknown) {
    this.jobs.delete(id as number)
  }
  setInterval(fn: () => void, ms: number) {
    const id = ++this.seq
    this.jobs.set(id, { at: this.now + ms, fn, every: ms })
    return id
  }
  clearInterval(id: unknown) {
    this.jobs.delete(id as number)
  }
  pendingDelays(): number[] {
    return [...this.jobs.values()].filter(j => j.every === null).map(j => j.at - this.now)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | null = null
      for (const e of this.jobs) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
      if (!next) break
      const [id, job] = next
      this.now = job.at
      if (job.every === null) this.jobs.delete(id)
      else job.at += job.every
      job.fn()
    }
    this.now = end
  }
}

export const tick = () => new Promise(r => setTimeout(r, 0))
