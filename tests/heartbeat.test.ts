import { describe, expect, it } from 'vitest'
import { expectedTicks, formatDuration, lostTicks, newHeartbeat, tick } from '../src/lib/heartbeat'

describe('heartbeat', () => {
  it('counts ticks, tracks the largest gap and flags long gaps beyond 2.5x', () => {
    let s = newHeartbeat(0)
    for (const t of [1000, 2000, 3000]) s = tick(s, t, 1000).state
    expect(s.ticks).toBe(3)
    expect(s.maxGapMs).toBe(1000)
    const r = tick(s, 8000, 1000)
    expect(r.gapMs).toBe(5000)
    expect(r.isLongGap).toBe(true)
    expect(r.state.maxGapMs).toBe(5000)
    expect(r.state.maxGapAt).toBe(8000)
    expect(r.state.gapsOver).toBe(1)
    expect(tick(s, 5500, 1000).isLongGap).toBe(false)
  })

  it('reports expected and lost ticks against the wall clock', () => {
    let s = newHeartbeat(0)
    s = tick(s, 1000, 1000).state
    s = tick(s, 9000, 1000).state
    expect(expectedTicks(s, 9000, 1000)).toBe(9)
    expect(lostTicks(s, 9000, 1000)).toBe(7)
    expect(lostTicks(newHeartbeat(0), 500, 1000)).toBe(0)
  })

  it('formats durations', () => {
    expect(formatDuration(5_400)).toBe('5s')
    expect(formatDuration(95_000)).toBe('1m35s')
    expect(formatDuration(3_725_000)).toBe('1h02m')
    expect(formatDuration(-1)).toBe('0s')
  })
})
