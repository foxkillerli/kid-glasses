import { describe, expect, it } from 'vitest'
import { Conversation, oneLine } from '../src/lib/conversation'
import { LENS_TEXT, fitsLensLine } from '../src/lib/lens-text'
import { PROGRESSIVE_KID_REVEAL, READING_SPEED, charsShownAfter, revealDurationMs } from '../src/lib/kid-reveal'

const kid = (seq: number, text: string) => ({ seq, from: 'kid' as const, text, at: 1, session: 's' })
const mine = (seq: number, text: string, cid?: string) => ({ seq, from: 'glasses' as const, text, at: 1, session: 's', ...(cid ? { cid } : {}) })

describe('Conversation (lens view)', () => {
  it('own turns take one lens line; Kid replies wrap with the lens rules', () => {
    const c = new Conversation({ progressiveReveal: false })
    c.upsert([mine(1, '今天下午几点放学，要不要我来接你，顺便去超市买点东西回家'), kid(2, '三点半')], 'live')
    const lines = c.view().body.split('\n')
    expect(lines[0].startsWith('我：')).toBe(true)
    expect(fitsLensLine(lines[0])).toBe(true)
    expect(lines[1]).toBe('Kid：三点半')
  })

  it('a long Kid reply is paginated with LENS_TEXT and the view jumps to its first page', () => {
    const c = new Conversation({ progressiveReveal: false })
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

const zi = (n: number) => '字'.repeat(n)
const linesPerPage = LENS_TEXT.bodyLines
const liveFor = (lines: number) => zi(lines * LENS_TEXT.zhCharsPerLine - 3)

describe('Conversation paging: fill-triggered, not timed', () => {
  it('(a) a growing live transcript stays on page 1 until it fills, then advances the moment line 9 appears', () => {
    const c = new Conversation({ progressiveReveal: false })
    c.setLive(liveFor(linesPerPage))
    expect(c.view()).toMatchObject({ page: 1, pages: 1 })
    expect(c.view().body.split('\n')).toHaveLength(linesPerPage)
    c.setLive(liveFor(linesPerPage) + '字')
    expect(c.view()).toMatchObject({ page: 2, pages: 2 })
    expect(c.view().body).toBe('字')
  })

  it('(a) appended messages advance to the page holding the newest one when the page fills', () => {
    const c = new Conversation({ progressiveReveal: false })
    for (let i = 1; i <= linesPerPage; i++) c.upsert([mine(i, `第${i}句`)], 'live')
    expect(c.view()).toMatchObject({ page: 1, pages: 1 })
    c.upsert([mine(linesPerPage + 1, '第九句')], 'live')
    expect(c.view()).toMatchObject({ page: 2, pages: 2, body: '我：第九句' })
  })

  it('(b) nothing flips pages with time: no timers, tick is a no-op, the page holds however long you wait', () => {
    let now = 0
    const c = new Conversation({ progressiveReveal: false, now: () => now })
    c.upsert([kid(1, zi(600))], 'live')
    const before = c.view()
    expect(before.pages).toBeGreaterThan(2)
    for (let i = 0; i < 20; i++) {
      now += 60_000
      expect(c.tick()).toBe(false)
    }
    expect(c.view()).toEqual(before)
    expect(c.revealing).toBe(false)
  })

  it('(c) after swiping back, re-layout, history, merges and posted pending entries do not yank the view forward', () => {
    const c = new Conversation({ progressiveReveal: false })
    c.setLive(liveFor(linesPerPage * 3))
    expect(c.view()).toMatchObject({ page: 3, pages: 3 })
    c.prev()
    expect(c.view().page).toBe(2)
    c.setLive(liveFor(linesPerPage * 3))
    c.upsert([kid(0, '早先的话')], 'history')
    c.setPending([{ cid: 'cid-aaaaaaaa', text: '待发', at: 1, tries: 0 }])
    c.prev()
    const at = c.view().page
    c.upsert([mine(1, '待发', 'cid-aaaaaaaa')], 'replay')
    c.upsert([mine(1, '待发', 'cid-aaaaaaaa')], 'replay')
    c.setPending([])
    c.tick()
    expect(c.view().page).toBe(at)
    expect(at).toBeLessThan(c.view().pages)
  })

  it('(d) new content (a new ASR chunk, or a new message) returns to the live page and fill-triggered advance resumes', () => {
    const c = new Conversation({ progressiveReveal: false })
    c.setLive(liveFor(linesPerPage * 2))
    c.prev()
    expect(c.view().page).toBe(1)
    c.setLive(liveFor(linesPerPage * 2) + '新')
    expect(c.view()).toMatchObject({ page: 3, pages: 3 })
    c.prev()
    c.prev()
    c.setLive(null)
    c.upsert([mine(1, '我发了一句')], 'live')
    expect(c.view().page).toBe(c.view().pages)
    for (let i = 2; i <= linesPerPage * 2; i++) c.upsert([mine(i, `第${i}句`)], 'live')
    expect(c.view().page).toBe(c.view().pages)
  })

  it('the shipped default follows PROGRESSIVE_KID_REVEAL, which is now on', () => {
    expect(PROGRESSIVE_KID_REVEAL).toBe(true)
    const c = new Conversation({ now: () => 0 })
    c.upsert([kid(1, zi(50))], 'live')
    expect(c.revealing).toBe(true)
    expect(c.view().body).toBe('Kid：')
  })

  it('(e) with the flag off, an all-at-once Kid reply shows in full from its page 1 and is never auto-walked', () => {
    let now = 0
    const c = new Conversation({ progressiveReveal: false, now: () => now })
    c.upsert([mine(1, '讲个故事')], 'live')
    const story = zi(300)
    c.upsert([kid(2, story)], 'live')
    expect(c.revealing).toBe(false)
    const v = c.view()
    expect(v.page).toBe(1)
    expect(v.pages).toBeGreaterThan(1)
    expect(v.body).toContain('Kid：字')
    expect(c.pages().flat().join('').replace(/^我：讲个故事Kid：/, '')).toBe(story)
    now += 10 * 60_000
    c.tick()
    expect(c.view()).toEqual(v)
    c.next()
    expect(c.view().page).toBe(2)
    c.prev()
    expect(c.view().page).toBe(1)
  })
})

describe('Progressive Kid reveal (function and class, flag forced on)', () => {
  it('charsShownAfter uses CJK vs Latin speeds from READING_SPEED', () => {
    expect(READING_SPEED).toEqual({ zhCharsPerSecond: 6, enCharsPerSecond: 15 })
    expect(charsShownAfter(zi(100), 1000)).toBe(6)
    expect(charsShownAfter('a'.repeat(100), 1000)).toBe(15)
    expect(charsShownAfter('字a字a', 1000 / 6 + 1000 / 15)).toBe(2)
    expect(revealDurationMs(zi(6) + 'a'.repeat(15))).toBeCloseTo(2000, 6)
    expect(charsShownAfter('', 5000)).toBe(0)
  })

  it('(f) reveals at reading speed, flips each time a page fills, and a skip shows the full pages for browsing', () => {
    let now = 0
    const c = new Conversation({ progressiveReveal: true, now: () => now })
    const story = zi(600)
    c.upsert([kid(1, story)], 'live')
    expect(c.revealing).toBe(true)
    expect(c.view()).toMatchObject({ body: 'Kid：', page: 1, pages: 1 })
    now = 1000
    c.tick()
    expect(c.view().body).toBe('Kid：' + zi(6))
    const flips: number[] = []
    let lastPage = 1
    while (c.revealing && now < 200_000) {
      now += 250
      c.tick()
      const v = c.view()
      expect(v.page).toBe(v.pages)
      if (v.page !== lastPage) flips.push(charsShownAfter(story, now))
      lastPage = v.page
    }
    expect(flips.length).toBeGreaterThanOrEqual(2)
    expect(c.revealing).toBe(false)
    expect(c.pages().flat().join('')).toBe('Kid：' + story)

    now = 0
    const d = new Conversation({ progressiveReveal: true, now: () => now })
    d.upsert([kid(1, story)], 'live')
    now = 45_000
    d.tick()
    const mid = d.view()
    expect(mid.pages).toBeLessThan(c.pages().length)
    expect(d.skipReveal()).toBe(true)
    expect(d.revealing).toBe(false)
    expect(d.pages().flat().join('')).toBe('Kid：' + story)
    expect(d.view().page).toBe(mid.page)
    d.next()
    expect(d.view().page).toBe(mid.page + 1)
    d.prev()
    d.prev()
    expect(d.view().page).toBe(mid.page - 1)
    now = 500_000
    d.tick()
    expect(d.view().page).toBe(mid.page - 1)
  })

  it('(f) new content during a reveal ends it and jumps to the live page; replayed and history replies are never revealed', () => {
    let now = 0
    const c = new Conversation({ progressiveReveal: true, now: () => now })
    c.upsert([kid(1, zi(400))], 'live')
    now = 5000
    c.tick()
    c.setLive('我插一句')
    expect(c.revealing).toBe(false)
    expect(c.view().page).toBe(c.view().pages)
    expect(c.view().body).toContain('你说：我插一句')
    const r = new Conversation({ progressiveReveal: true, now: () => now })
    r.upsert([kid(1, zi(400))], 'replay')
    expect(r.revealing).toBe(false)
    expect(r.view().page).toBe(1)
  })
})

