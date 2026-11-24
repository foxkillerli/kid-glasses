import { describe, expect, it, vi } from 'vitest'
import { ChannelNotAllowedError, KidDmClient, SlackApiError, SlackConfigError } from '../src/slack-client'

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
