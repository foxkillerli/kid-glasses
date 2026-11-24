import { describe, expect, it } from 'vitest'
import { MemoryKV, RingLog, type KV } from '../src/lib/ringlog'

describe('RingLog', () => {
  it('keeps only the newest entries up to capacity and survives a reload', () => {
    const kv = new MemoryKV()
    const log = new RingLog(kv, 'k', 3)
    for (let i = 1; i <= 5; i++) log.add(i, 1, `m${i}`)
    expect(log.all().map(e => e.m)).toEqual(['m3', 'm4', 'm5'])
    const again = new RingLog(kv, 'k', 3)
    expect(again.last(2).map(e => e.m)).toEqual(['m4', 'm5'])
  })

  it('clears the stored log', () => {
    const kv = new MemoryKV()
    const log = new RingLog(kv, 'k', 3)
    log.add(1, 1, 'x')
    log.clear()
    expect(log.size).toBe(0)
    expect(kv.getItem('k')).toBeNull()
  })

  it('ignores corrupt stored data', () => {
    const kv = new MemoryKV()
    kv.setItem('k', '{not json')
    expect(new RingLog(kv, 'k', 3).size).toBe(0)
  })

  it('trims a quarter of the log when storage is full', () => {
    const inner = new MemoryKV()
    let failNext = false
    const kv: KV = {
      getItem: k => inner.getItem(k),
      removeItem: k => inner.removeItem(k),
      setItem: (k, v) => {
        if (failNext) {
          failNext = false
          throw new Error('QuotaExceededError')
        }
        inner.setItem(k, v)
      },
    }
    const log = new RingLog(kv, 'k', 100)
    for (let i = 0; i < 8; i++) log.add(i, 1, `m${i}`)
    failNext = true
    log.add(8, 1, 'm8')
    expect(log.size).toBe(6)
    expect(JSON.parse(inner.getItem('k') as string)).toHaveLength(6)
  })
})
