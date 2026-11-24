import { describe, expect, it } from 'vitest'
import { LIMIT_CREATE, LIMIT_UPGRADE, clampToLimit, fitsLimit, utf8Bytes } from '../src/lib/limits'

describe('write limits', () => {
  it('uses the documented create/upgrade limits', () => {
    expect(LIMIT_CREATE).toBe(1000)
    expect(LIMIT_UPGRADE).toBe(2000)
  })

  it('counts CJK as 3 UTF-8 bytes', () => {
    expect(utf8Bytes('汉a')).toBe(4)
    expect(fitsLimit('汉'.repeat(333), 1000)).toBe(true)
    expect(fitsLimit('汉'.repeat(334), 1000)).toBe(false)
  })

  it('clamps to the longest prefix that fits with an ellipsis', () => {
    const out = clampToLimit('汉'.repeat(400), 1000)
    expect(utf8Bytes(out)).toBeLessThanOrEqual(1000)
    expect(out.endsWith('…')).toBe(true)
    expect(out).toBe('汉'.repeat(332) + '…')
    expect(clampToLimit('short', 1000)).toBe('short')
  })
})
