import { describe, expect, it } from 'vitest'
import { Conversation, oneLine } from '../src/lib/conversation'
import { LENS_TEXT, fitsLensLine } from '../src/lib/lens-text'

const kid = (seq: number, text: string) => ({ seq, from: 'kid' as const, text, at: 1, session: 's' })
const mine = (seq: number, text: string, cid?: string) => ({ seq, from: 'glasses' as const, text, at: 1, session: 's', ...(cid ? { cid } : {}) })

describe('Conversation (lens view)', () => {
  it('own turns take one lens line; Kid replies wrap with the lens rules', () => {
    const c = new Conversation()
    c.upsert([mine(1, '今天下午几点放学，要不要我来接你，顺便去超市买点东西回家'), kid(2, '三点半')], 'live')
    const lines = c.view().body.split('\n')
    expect(lines[0].startsWith('我：')).toBe(true)
    expect(fitsLensLine(lines[0])).toBe(true)
    expect(lines[1]).toBe('Kid：三点半')
  })

  it('a long Kid reply is paginated with LENS_TEXT and the view jumps to its first page', () => {
    const c = new Conversation()
    for (let i = 1; i <= 12; i++) c.upsert([mine(i, `问题${i}`)], 'live')
    const long = '这是一段很长的回复。'.repeat(40)
    c.upsert([kid(13, long)], 'live')
    const v = c.view()
    expect(v.pages).toBeGreaterThan(2)
    expect(v.body).toContain('Kid：这是一段')
    for (const page of c.pages()) expect(page.length).toBeLessThanOrEqual(LENS_TEXT.bodyLines)
    c.next()
    expect(c.view().page).toBe(v.page + 1)
    c.prev()
    c.prev()
    expect(c.view().page).toBe(v.page - 1)
  })

  it('history fills the view without jumping; duplicates by seq are merged', () => {
    const c = new Conversation()
    c.upsert([kid(1, 'a'), kid(2, 'b')], 'history')
    c.upsert([kid(2, 'b')], 'replay')
    expect(c.view().body).toBe('Kid：a\nKid：b')
  })

  it('pending turns show until the relay echoes their cid', () => {
    const c = new Conversation()
    c.setPending([{ cid: 'c1', text: '离线时说的话', at: 1, tries: 0 }])
    expect(c.view().body).toBe('我（待发）：离线时说的话')
    c.upsert([mine(1, '离线时说的话', 'c1')], 'live')
    c.setPending([{ cid: 'c1', text: '离线时说的话', at: 1, tries: 0 }])
    expect(c.view().body).toBe('我：离线时说的话')
  })

  it('oneLine truncates to one lens line with an ellipsis', () => {
    const s = oneLine('字'.repeat(80))
    expect(fitsLensLine(s)).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
})
