import { describe, expect, it } from 'vitest'
import { PcmAccumulator, bytesToSeconds, clipStats, levelBar, rms, toDbfs } from '../src/lib/audio'

function le16(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  values.forEach((v, i) => {
    out[i * 2] = v & 0xff
    out[i * 2 + 1] = (v >> 8) & 0xff
  })
  return out
}

describe('rms / dBFS', () => {
  it('computes rms of a square wave and full-scale dBFS', () => {
    expect(rms(new Int16Array([1000, -1000, 1000, -1000]))).toBe(1000)
    expect(rms(new Int16Array([]))).toBe(0)
    expect(toDbfs(32768)).toBeCloseTo(0, 6)
    expect(toDbfs(0)).toBe(-Infinity)
  })

  it('draws a 16-cell level bar clamped to [-60, 0] dB', () => {
    expect(levelBar(0)).toBe('█'.repeat(16))
    expect(levelBar(-60)).toBe('─'.repeat(16))
    expect(levelBar(-Infinity)).toBe('─'.repeat(16))
    expect(levelBar(-30)).toBe('█'.repeat(8) + '─'.repeat(8))
  })
})

describe('PcmAccumulator', () => {
  it('decodes s16le, keeps an odd trailing byte across frames, and counts frames/bytes', () => {
    const acc = new PcmAccumulator(1)
    const bytes = le16([1, -2, 300, -32768])
    acc.push(bytes.subarray(0, 3))
    acc.push(bytes.subarray(3))
    expect(Array.from(acc.samples())).toEqual([1, -2, 300, -32768])
    expect(acc.frames).toBe(2)
    expect(acc.totalBytes).toBe(8)
  })

  it('tracks per-frame rms and clip stats in 16 kHz seconds', () => {
    const acc = new PcmAccumulator(1)
    acc.push(le16(new Array(1600).fill(0).map((_, i) => (i % 2 ? -1000 : 1000))))
    expect(acc.lastFrameRms).toBe(1000)
    const c = clipStats(acc)
    expect(c.seconds).toBeCloseTo(0.1, 6)
    expect(c.bytes).toBe(3200)
    expect(bytesToSeconds(32000)).toBe(1)
  })

  it('caps the stored samples and counts the dropped ones', () => {
    const acc = new PcmAccumulator(0.001)
    acc.push(le16(new Array(20).fill(7)))
    expect(acc.sampleCount).toBe(16)
    expect(acc.droppedSamples).toBe(4)
    expect(acc.totalBytes).toBe(40)
  })
})
