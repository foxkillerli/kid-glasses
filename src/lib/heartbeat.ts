export interface HeartbeatState {
  startedAt: number
  ticks: number
  lastTickAt: number
  maxGapMs: number
  maxGapAt: number
  gapsOver: number
}

export function newHeartbeat(now: number): HeartbeatState {
  return { startedAt: now, ticks: 0, lastTickAt: now, maxGapMs: 0, maxGapAt: 0, gapsOver: 0 }
}

export interface TickResult {
  state: HeartbeatState
  gapMs: number
  isLongGap: boolean
}

export function tick(state: HeartbeatState, now: number, intervalMs: number, longGapFactor = 2.5): TickResult {
  const gapMs = now - state.lastTickAt
  const isLongGap = gapMs > intervalMs * longGapFactor
  const next: HeartbeatState = {
    ...state,
    ticks: state.ticks + 1,
    lastTickAt: now,
    maxGapMs: gapMs > state.maxGapMs ? gapMs : state.maxGapMs,
    maxGapAt: gapMs > state.maxGapMs ? now : state.maxGapAt,
    gapsOver: state.gapsOver + (isLongGap ? 1 : 0),
  }
  return { state: next, gapMs, isLongGap }
}

export function expectedTicks(state: HeartbeatState, now: number, intervalMs: number): number {
  return Math.max(0, Math.floor((now - state.startedAt) / intervalMs))
}

export function lostTicks(state: HeartbeatState, now: number, intervalMs: number): number {
  return Math.max(0, expectedTicks(state, now, intervalMs) - state.ticks)
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

export function hhmmss(ts: number): string {
  const d = new Date(ts)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':')
}

export function hhmm(ts: number): string {
  return hhmmss(ts).slice(0, 5)
}
