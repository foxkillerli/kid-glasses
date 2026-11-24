import { LIMIT_REBUILD, LIMIT_UPGRADE, clampToLimit } from './limits'

export interface TextBox {
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  content: string
  capture?: boolean
  padding?: number
  border?: number
}

export interface Layout {
  key: string
  boxes: TextBox[]
}

export interface DisplaySink {
  rebuild(layout: Layout): Promise<boolean>
  upgrade(box: { id: number; name: string; content: string }): Promise<boolean>
}

export function normalizeLayout(layout: Layout): Layout {
  const captures = layout.boxes.filter(b => b.capture).length
  if (captures !== 1) throw new Error(`layout ${layout.key} must have exactly one capture box, has ${captures}`)
  const ids = new Set(layout.boxes.map(b => b.id))
  if (ids.size !== layout.boxes.length) throw new Error(`layout ${layout.key} has duplicate ids`)
  for (const b of layout.boxes) {
    if (b.name.length > 16) throw new Error(`container name too long: ${b.name}`)
  }
  return {
    key: layout.key,
    boxes: layout.boxes.map(b => ({ ...b, content: clampToLimit(b.content, LIMIT_REBUILD) })),
  }
}

type Job = { kind: 'rebuild'; layout: Layout } | { kind: 'upgrade'; id: number; name: string; content: string }

export class DisplayQueue {
  private pendingRebuild: Layout | null = null
  private pendingUpgrades = new Map<number, { id: number; name: string; content: string }>()
  private busy = false
  private current: Layout | null = null
  private inflight: Layout | null = null
  writes = 0
  failures = 0
  lastError = ''
  timeouts = 0
  onRebuildFailed: ((key: string) => void) | null = null

  constructor(
    private readonly sink: DisplaySink,
    private readonly timeoutMs = 3000,
  ) {}

  private withTimeout(p: Promise<boolean>): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.timeouts++
        this.lastError = `timeout ${this.timeoutMs}ms`
        resolve(false)
      }, this.timeoutMs)
      p.then(
        v => {
          clearTimeout(timer)
          resolve(v)
        },
        err => {
          clearTimeout(timer)
          this.lastError = String(err)
          resolve(false)
        },
      )
    })
  }

  get layout(): Layout | null {
    return this.current
  }

  setLayout(layout: Layout): void {
    this.pendingRebuild = normalizeLayout(layout)
    this.pendingUpgrades.clear()
    this.pump()
  }

  setText(id: number, content: string): void {
    const target = this.pendingRebuild ?? this.inflight ?? this.current
    const box = target?.boxes.find(b => b.id === id)
    if (!box) return
    const clamped = clampToLimit(content, this.pendingRebuild ? LIMIT_REBUILD : LIMIT_UPGRADE)
    if (this.pendingRebuild) {
      box.content = clamped
      return
    }
    if (box.content === clamped && !this.pendingUpgrades.has(id)) return
    this.pendingUpgrades.set(id, { id, name: box.name, content: clamped })
    this.pump()
  }

  idle(): boolean {
    return !this.busy && !this.pendingRebuild && this.pendingUpgrades.size === 0
  }

  private next(): Job | null {
    if (this.pendingRebuild) {
      const layout = this.pendingRebuild
      this.pendingRebuild = null
      return { kind: 'rebuild', layout }
    }
    const first = this.pendingUpgrades.values().next()
    if (first.done) return null
    this.pendingUpgrades.delete(first.value.id)
    return { kind: 'upgrade', ...first.value }
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      for (let job = this.next(); job; job = this.next()) {
        let ok = false
        try {
          if (job.kind === 'rebuild') {
            this.inflight = job.layout
            try {
              ok = await this.withTimeout(this.sink.rebuild(job.layout))
            } finally {
              this.inflight = null
            }
            if (ok) this.current = job.layout
          } else {
            ok = await this.withTimeout(this.sink.upgrade(job))
            const box = this.current?.boxes.find(b => b.id === job.id)
            if (ok && box) box.content = job.content
          }
        } catch (err) {
          this.lastError = String(err)
        }
        this.writes++
        if (!ok) {
          this.failures++
          if (job.kind === 'rebuild') this.onRebuildFailed?.(job.layout.key)
        }
      }
    } finally {
      this.busy = false
    }
  }
}
