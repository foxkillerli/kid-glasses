export type MicHealth = 'idle' | 'waiting' | 'ok' | 'no-frames' | 'stalled'

export interface MicHealthInput {
  recording: boolean
  startedAt: number
  frames: number
  lastFrameAt: number
  now: number
  timeoutMs: number
}

export function micHealth(s: MicHealthInput): MicHealth {
  if (!s.recording) return 'idle'
  if (s.frames === 0) return s.now - s.startedAt >= s.timeoutMs ? 'no-frames' : 'waiting'
  return s.now - s.lastFrameAt >= s.timeoutMs ? 'stalled' : 'ok'
}

export function micHealthLine(h: MicHealth, s: MicHealthInput): string {
  switch (h) {
    case 'no-frames':
      return `!! NO AUDIO FRAMES ${Math.floor((s.now - s.startedAt) / 1000)}s - check wear / connection`
    case 'stalled':
      return `!! AUDIO STALLED ${Math.floor((s.now - s.lastFrameAt) / 1000)}s - check wear / connection`
    case 'waiting':
      return 'waiting for first audio frame...'
    case 'ok':
      return 'audio frames arriving'
    case 'idle':
      return ''
  }
}

export interface FrameSourceCount {
  glasses: number
  phone: number
  other: number
}

export function countFrameSource(c: FrameSourceCount, source: unknown): FrameSourceCount {
  if (source === 'glasses') return { ...c, glasses: c.glasses + 1 }
  if (source === 'phone') return { ...c, phone: c.phone + 1 }
  return { ...c, other: c.other + 1 }
}
