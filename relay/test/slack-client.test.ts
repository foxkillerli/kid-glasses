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
