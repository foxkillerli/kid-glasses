import { describe, expect, it } from 'vitest'
import { classify, eventTypeOf } from '../src/lib/events'

describe('classify', () => {
  it('reads a click whose eventType was omitted by protobuf zero-omission', () => {
    expect(eventTypeOf({})).toBe(0)
    expect(classify({ sysEvent: {} })).toEqual({ gesture: 'click', via: 'sys', rawType: 0 })
  })

  it('maps swipes on the text envelope and long-press on sys', () => {
    expect(classify({ textEvent: { eventType: 1 } })?.gesture).toBe('up')
    expect(classify({ textEvent: { eventType: 2 } })?.gesture).toBe('down')
    expect(classify({ sysEvent: { eventType: 9 } })?.gesture).toBe('longStart')
    expect(classify({ sysEvent: { eventType: 10 } })?.gesture).toBe('longEnd')
    expect(classify({ sysEvent: { eventType: 3 } })?.gesture).toBe('double')
    expect(classify({ sysEvent: { eventType: 4 } })?.gesture).toBe('fgEnter')
    expect(classify({ listEvent: { eventType: 0 } })?.via).toBe('list')
  })

  it('prefers sys over text and ignores unknown types and audio-only events', () => {
    expect(classify({ sysEvent: { eventType: 3 }, textEvent: { eventType: 1 } })?.gesture).toBe('double')
    expect(classify({ sysEvent: { eventType: 99 } })).toBeNull()
    expect(classify({ audioEvent: {} })).toBeNull()
    expect(classify({ sysEvent: null })).toBeNull()
  })
})
