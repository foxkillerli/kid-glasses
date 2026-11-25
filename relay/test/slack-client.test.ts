import { describe, expect, it, vi } from 'vitest'
import { ChannelNotAllowedError, KidDmClient, RECONCILE_MAX_PAGES, SlackApiError, SlackConfigError, SlackTimeoutError, slackErrorIsUncertain } from '../src/slack-client'

const KID = 'D0123ABCDEF'
const TOKEN = ['xoxp', 'fake', 'token'].join('-')

function okFetch(channel = KID) {
  return vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, ts: '1700000000.000200', channel }))
}

describe('KidDmClient channel allowlist', () => {
  it('posts to the Kid DM as the user token, with thread_ts when given', async () => {
    const f = okFetch()
    const c = new KidDmClient(TOKEN, KID, f)
    expect(await c.postMessage(KID, '〔眼镜〕hi', '1700000000.000001')).toEqual({ ts: '1700000000.000200', channel: KID })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual({ channel: KID, text: '〔眼镜〕hi', thread_ts: '1700000000.000001', unfurl_links: false, unfurl_media: false })
  })

  it('refuses any other channel without calling Slack', async () => {
    const f = okFetch()
    const c = new KidDmClient(TOKEN, KID, f)
    for (const ch of ['D9999999999', 'C0123ABCDEF', 'G0123ABCDEF', 'U0123ABCDEF', '', `${KID} `, KID.toLowerCase()]) {
      await expect(c.postMessage(ch, 'x', null)).rejects.toBeInstanceOf(ChannelNotAllowedError)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('refuses when the configured channel is missing or not a DM id', async () => {
    const f = okFetch()
    await expect(new KidDmClient(TOKEN, undefined, f).postToKid('x', null)).rejects.toBeInstanceOf(SlackConfigError)
    await expect(new KidDmClient(TOKEN, 'C0123ABCDEF', f).postMessage('C0123ABCDEF', 'x', null)).rejects.toBeInstanceOf(SlackConfigError)
    expect(f).not.toHaveBeenCalled()
  })

  it('refuses a bot token or a missing token', async () => {
    const f = okFetch()
    await expect(new KidDmClient('xoxb-bot', KID, f).postToKid('x', null)).rejects.toBeInstanceOf(SlackConfigError)
    await expect(new KidDmClient(undefined, KID, f).postToKid('x', null)).rejects.toBeInstanceOf(SlackConfigError)
    expect(f).not.toHaveBeenCalled()
  })

  it('surfaces Slack errors and rate limits, and rejects a reply naming another channel', async () => {
    const err = vi.fn(async () => Response.json({ ok: false, error: 'not_in_channel' }))
    await expect(new KidDmClient(TOKEN, KID, err).postToKid('x', null)).rejects.toMatchObject({ code: 'not_in_channel' })
    const limited = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '3' } }))
    await expect(new KidDmClient(TOKEN, KID, limited).postToKid('x', null)).rejects.toEqual(new SlackApiError('ratelimited', 3))
    await expect(new KidDmClient(TOKEN, KID, okFetch('D7777777777')).postToKid('x', null)).rejects.toBeInstanceOf(ChannelNotAllowedError)
  })
})

describe('KidDmClient.selfUserId', () => {
  it("resolves the token's own user id with auth.test and caches it", async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true, user_id: 'UFOX0001' }))
    const c = new KidDmClient(TOKEN, KID, f)
    expect(await c.selfUserId()).toBe('UFOX0001')
    expect(await c.selfUserId()).toBe('UFOX0001')
    expect(f).toHaveBeenCalledOnce()
    expect(f.mock.calls[0][0]).toBe('https://slack.com/api/auth.test')
  })

  it('returns null and retries later when the lookup fails', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: false, error: 'invalid_auth' }))
    const c = new KidDmClient(TOKEN, KID, f)
    expect(await c.selfUserId()).toBeNull()
    await new Promise(r => setTimeout(r, 0))
    expect(await c.selfUserId()).toBeNull()
    expect(f).toHaveBeenCalledTimes(2)
    expect(await new KidDmClient('xoxb-bot', KID, f).selfUserId()).toBeNull()
  })
})

describe('KidDmClient.findOwnPost (reconcile an uncertain post)', () => {
  const TOKEN = ['xoxp', 'fake', 'token'].join('-')
  const CH = 'D0123ABCDEF'
  function client(messages: Array<Record<string, unknown>>, status = 200) {
    const urls: string[] = []
    const fetchFn = async (url: string) => {
      urls.push(url)
      if (url.includes('auth.test')) return Response.json({ ok: true, user_id: 'UFOX0001' })
      return status === 429 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : Response.json({ ok: true, messages })
    }
    return { c: new KidDmClient(TOKEN, CH, fetchFn as unknown as typeof fetch), urls }
  }

  it('searches the thread with conversations.replies, or the DM with conversations.history, and matches own text only', async () => {
    const msgs = [
      { ts: '1.1', user: 'UKIDBOT01', text: '〔眼镜〕hi' },
      { ts: '1.2', user: 'UFOX0001', text: '〔眼镜〕hi' },
    ]
    const a = client(msgs)
    expect(await a.c.findOwnPost('〔眼镜〕hi', '1.0', 1_700_000_000_000)).toEqual({ ts: '1.2', channel: CH })
    expect(a.urls.find(u => u.includes('conversations.replies'))).toContain('ts=1.0')
    const b = client(msgs)
    expect(await b.c.findOwnPost('〔眼镜〕other', null, 1_700_000_000_000)).toBeNull()
    expect(b.urls.some(u => u.includes('conversations.history'))).toBe(true)
  })

  it('throws on rate limiting so the caller does not post blindly', async () => {
    const { c } = client([], 429)
    await expect(c.findOwnPost('x', null, 0)).rejects.toThrow('ratelimited')
  })
})

describe('M3-1 Slack deadlines and M3-4 reconcile pagination', () => {
  const hang = () => new Promise<Response>(() => {})

  it('a hung chat.postMessage rejects with SlackTimeoutError after the deadline, aborts the fetch, and is not retried', async () => {
    let signal: AbortSignal | undefined
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return hang()
    })
    const c = new KidDmClient(TOKEN, KID, f, 20)
    await expect(c.postToKid('x', null)).rejects.toBeInstanceOf(SlackTimeoutError)
    expect(signal?.aborted).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a response whose body never finishes also hits the deadline', async () => {
    const f = vi.fn(async () => ({ status: 200, headers: new Headers(), json: () => new Promise(() => {}) }) as unknown as Response)
    const c = new KidDmClient(TOKEN, KID, f, 20)
    await expect(c.postToKid('x', null)).rejects.toBeInstanceOf(SlackTimeoutError)
  })

  it('read-only calls retry once on a timeout or a 5xx, then give up', async () => {
    const replies = [hang, async () => Response.json({ ok: true, user_id: 'USELF001' })]
    const f = vi.fn(async () => (replies.shift() as () => Promise<Response>)())
    const c = new KidDmClient(TOKEN, KID, f, 20)
    expect(await c.selfUserId()).toBe('USELF001')
    expect(f).toHaveBeenCalledTimes(2)
    const five = vi.fn(async () => new Response('oops', { status: 503 }))
    const c2 = new KidDmClient(TOKEN, KID, five, 20)
    expect(await c2.selfUserId()).toBeNull()
    expect(five).toHaveBeenCalledTimes(2)
    const dead = vi.fn(async () => hang())
    const c3 = new KidDmClient(TOKEN, KID, dead, 20)
    expect(await c3.selfUserId()).toBeNull()
    expect(dead).toHaveBeenCalledTimes(2)
  })

  it('reconcile follows next_cursor across pages and finds a post beyond the first 200 messages', async () => {
    const urls: string[] = []
    const f = vi.fn(async (u: string) => {
      urls.push(u)
      if (u.includes('auth.test')) return Response.json({ ok: true, user_id: 'USELF001' })
      const cursor = new URL(u).searchParams.get('cursor')
      if (!cursor) return Response.json({ ok: true, messages: [{ ts: '1.1', user: 'UOTHER01', text: 'x' }], response_metadata: { next_cursor: 'p2' } })
      if (cursor === 'p2') return Response.json({ ok: true, messages: [{ ts: '1.2', user: 'USELF001', text: 'other' }], response_metadata: { next_cursor: 'p3' } })
      return Response.json({ ok: true, messages: [{ ts: '1.3', user: 'USELF001', text: '〔眼镜〕找我' }], response_metadata: { next_cursor: '' } })
    })
    const c = new KidDmClient(TOKEN, KID, f, 1000)
    expect(await c.findOwnPost('〔眼镜〕找我', '1.0', 1_700_000_000_000)).toEqual({ ts: '1.3', channel: KID })
    const pages = urls.filter(u => u.includes('conversations.replies'))
    expect(pages.map(u => new URL(u).searchParams.get('cursor'))).toEqual([null, 'p2', 'p3'])
    expect(pages.every(u => new URL(u).searchParams.get('oldest') === '1699999940')).toBe(true)
  })

  it('reconcile stops at the last page with no match, and refuses to guess after the page cap', async () => {
    const last = vi.fn(async (u: string) =>
      u.includes('auth.test') ? Response.json({ ok: true, user_id: 'USELF001' }) : Response.json({ ok: true, messages: [], response_metadata: { next_cursor: '' } }),
    )
    expect(await new KidDmClient(TOKEN, KID, last, 1000).findOwnPost('t', null, 1)).toBeNull()
    let n = 0
    const endless = vi.fn(async (u: string) =>
      u.includes('auth.test') ? Response.json({ ok: true, user_id: 'USELF001' }) : Response.json({ ok: true, messages: [], response_metadata: { next_cursor: `c${++n}` } }),
    )
    await expect(new KidDmClient(TOKEN, KID, endless, 1000).findOwnPost('t', null, 1)).rejects.toMatchObject({ code: 'reconcile_too_many_pages' })
    expect(endless.mock.calls.filter(([u]) => String(u).includes('conversations.history'))).toHaveLength(RECONCILE_MAX_PAGES)
  })
})

describe('M3 round 2: reconcile robustness', () => {
  it('matches Slack-formatted links and refuses to guess when has_more is set without a cursor', async () => {
    const f = vi.fn(async (u: string) => {
      if (u.includes('auth.test')) return Response.json({ ok: true, user_id: 'USELF001' })
      return Response.json({ ok: true, messages: [{ ts: '2.1', user: 'USELF001', text: '〔眼镜〕看 <https://example.invalid/a|example.invalid/a> 和 <mailto:a@b.invalid|a@b.invalid>' }] })
    })
    expect(await new KidDmClient(TOKEN, KID, f, 1000).findOwnPost('〔眼镜〕看 https://example.invalid/a 和 a@b.invalid', null, 1)).toEqual({ ts: '2.1', channel: KID })
    const partial = vi.fn(async (u: string) =>
      u.includes('auth.test') ? Response.json({ ok: true, user_id: 'USELF001' }) : Response.json({ ok: true, messages: [], has_more: true }),
    )
    await expect(new KidDmClient(TOKEN, KID, partial, 1000).findOwnPost('x', null, 1)).rejects.toMatchObject({ code: 'reconcile_incomplete' })
  })

  it('classifies Slack errors that may follow a write as uncertain', () => {
    for (const c of ['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable', 'http_500', 'http_503']) expect(slackErrorIsUncertain(c)).toBe(true)
    for (const c of ['ratelimited', 'channel_not_found', 'msg_too_long', 'invalid_auth', 'http_400']) expect(slackErrorIsUncertain(c)).toBe(false)
  })
})
