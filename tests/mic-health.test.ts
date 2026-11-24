import { describe, expect, it } from 'vitest'
import { countFrameSource, micHealth, micHealthLine, rawAudioMeta, type MicHealthInput } from '../src/lib/mic-health'

const base: MicHealthInput = { recording: true, startedAt: 1000, frames: 0, lastFrameAt: 0, now: 1000, timeoutMs: 3000 }

describe('micHealth', () => {
  it('is idle when not recording', () => {
    expect(micHealth({ ...base, recording: false, now: 99999 })).toBe('idle')
  })

  it('waits for the first frame, then flags NO AUDIO FRAMES at the timeout', () => {
    expect(micHealth({ ...base, now: 3999 })).toBe('waiting')
    const late = { ...base, now: 4000 }
    expect(micHealth(late)).toBe('no-frames')
    expect(micHealthLine('no-frames', late)).toBe('!! NO AUDIO FRAMES 3s - check wear / connection')
  })

  it('is ok while frames keep arriving and stalls when they stop', () => {
    expect(micHealth({ ...base, frames: 5, lastFrameAt: 5000, now: 7999 })).toBe('ok')
    const stalled = { ...base, frames: 5, lastFrameAt: 5000, now: 9100 }
    expect(micHealth(stalled)).toBe('stalled')
    expect(micHealthLine('stalled', stalled)).toMatch(/^!! AUDIO STALLED 4s/)
  })
})

describe('countFrameSource', () => {
  it('counts glasses, phone and unknown sources separately', () => {
    let c = { glasses: 0, phone: 0, other: 0 }
    for (const s of ['glasses', 'glasses', 'phone', undefined]) c = countFrameSource(c, s)
    expect(c).toEqual({ glasses: 2, phone: 1, other: 1 })
  })
})

describe('rawAudioMeta', () => {
  it('lists the host fields next to the PCM, so a missing source is visible', () => {
    expect(rawAudioMeta({ audioPcm: [0, 0] })).toBe('no source field')
    expect(rawAudioMeta({ audioPcm: [0, 0], audioSource: 'glasses', direction: 12 })).toBe('audioSource=glasses direction=12')
    expect(rawAudioMeta({ audio_pcm: 'AAA=', source: 'phone', direction: null })).toBe('source=phone direction=null')
    expect(rawAudioMeta(undefined)).toBe('no raw json')
  })
})
