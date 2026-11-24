import { describe, expect, it, vi } from 'vitest'
import { DisplayQueue, type DisplaySink, type Layout } from '../src/lib/display'

function layout(key: string, body = 'x'): Layout {
  return {
    key,
    boxes: [
      { id: 1, name: 'cap', x: 0, y: 0, w: 10, h: 10, content: ' ', capture: true },
      { id: 3, name: 'body', x: 0, y: 0, w: 10, h: 10, content: body },
    ],
  }
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe('DisplayQueue', () => {
  it('coalesces upgrades per container while a write is in flight', async () => {
    const upgrades: string[] = []
    let release: (v: boolean) => void = () => {}
    const sink: DisplaySink = {
      rebuild: () => new Promise(r => (release = r)),
      upgrade: async b => {
        upgrades.push(b.content)
        return true
      },
    }
    const q = new DisplayQueue(sink)
    q.setLayout(layout('a'))
    await flush()
    q.setText(3, 'one')
    q.setText(3, 'two')
    release(true)
    await flush()
    await flush()
    expect(q.layout?.boxes[1].content).toBe('two')
    q.setText(3, 'three')
    q.setText(3, 'four')
    await flush()
    await flush()
    expect(upgrades).toEqual(['two', 'three', 'four'])
    expect(q.layout?.boxes[1].content).toBe('four')
  })

  it('times out a hung write, counts it, and reports the failed rebuild', async () => {
    vi.useFakeTimers()
    const sink: DisplaySink = {
      rebuild: () => new Promise(() => {}),
      upgrade: async () => true,
    }
    const q = new DisplayQueue(sink, 3000)
    const failed: string[] = []
    q.onRebuildFailed = key => failed.push(key)
    q.setLayout(layout('hung'))
    await vi.advanceTimersByTimeAsync(3100)
    expect(q.timeouts).toBe(1)
    expect(q.failures).toBe(1)
    expect(failed).toEqual(['hung'])
    expect(q.idle()).toBe(true)
    vi.useRealTimers()
  })

  it('rejects layouts without exactly one capture container', () => {
    const q = new DisplayQueue({ rebuild: async () => true, upgrade: async () => true })
    const bad = layout('bad')
    bad.boxes[0].capture = false
    expect(() => q.setLayout(bad)).toThrow(/exactly one capture/)
  })
})
