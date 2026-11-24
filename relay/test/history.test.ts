import { describe, expect, it } from 'vitest'
import { HistoryStore } from '../src/history'
import { FakeStorage } from './fakes'

async function filled(n: number, cap = 500) {
  const h = new HistoryStore(new FakeStorage(), cap)
  for (let i = 1; i <= n; i++) await h.append({ from: i % 2 ? 'glasses' : 'kid', text: `m${i}`, slackTs: null, threadTs: null, at: i })
  return h
}

describe('HistoryStore', () => {
  it('pages newest-first windows returned oldest-first, with a more flag', async () => {
    const h = await filled(7)
    const p1 = await h.page(null, 3)
    expect(p1.items.map(i => i.text)).toEqual(['m5', 'm6', 'm7'])
    expect(p1.more).toBe(true)
    const p2 = await h.page(p1.items[0].seq, 3)
    expect(p2.items.map(i => i.text)).toEqual(['m2', 'm3', 'm4'])
    const p3 = await h.page(p2.items[0].seq, 3)
    expect(p3.items.map(i => i.text)).toEqual(['m1'])
    expect(p3.more).toBe(false)
  })

  it('replays messages after a sequence number', async () => {
    const h = await filled(5)
    expect((await h.since(3)).map(i => i.seq)).toEqual([4, 5])
    expect(await h.lastSeq()).toBe(5)
  })

  it('drops the oldest entries beyond the cap and clamps page size', async () => {
    const h = await filled(12, 10)
    const all = await h.page(null, 100)
    expect(all.items.map(i => i.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect((await h.page(null, 0)).items).toHaveLength(1)
  })
})
