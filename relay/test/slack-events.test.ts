import { describe, expect, it } from 'vitest'
import { routeSlackEvent } from '../src/slack-events'

const KID = 'D0123ABCDEF'
const FOX = 'UFOX12345'

function msg(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    event_id: 'Ev1',
    authorizations: [{ user_id: FOX, is_bot: false }],
    event: { type: 'message', channel: KID, channel_type: 'im', user: 'UKID00001', text: '你好', ts: '1700000000.000100', ...event },
    ...extra,
  }
}

describe('routeSlackEvent', () => {
  it('answers url_verification with the challenge', () => {
    expect(routeSlackEvent({ type: 'url_verification', challenge: 'abc123' }, KID)).toEqual({ kind: 'challenge', challenge: 'abc123' })
  })

  it('routes a Kid DM message to the device, keeping thread_ts', () => {
    const r = routeSlackEvent(msg({ thread_ts: '1700000000.000001' }), KID)
    expect(r).toEqual({
      kind: 'kid-message',
      message: { eventId: 'Ev1', channel: KID, user: 'UKID00001', text: '你好', ts: '1700000000.000100', threadTs: '1700000000.000001' },
    })
  })

  it('accepts messages from a bot user in the Kid DM', () => {
    expect(routeSlackEvent(msg({ subtype: 'bot_message', user: undefined, bot_id: 'B1' }), KID).kind).toBe('kid-message')
  })

  it('ignores other channels, other event types, edits/deletes, hidden and empty messages', () => {
    expect(routeSlackEvent(msg({ channel: 'D9999999999' }), KID)).toEqual({ kind: 'ignore', reason: 'other-channel' })
    expect(routeSlackEvent(msg({ channel: 'C0123ABCDEF', channel_type: 'channel' }), KID)).toEqual({ kind: 'ignore', reason: 'other-channel' })
    expect(routeSlackEvent(msg({ type: 'reaction_added' }), KID).kind).toBe('ignore')
    expect(routeSlackEvent(msg({ subtype: 'message_changed' }), KID)).toEqual({ kind: 'ignore', reason: 'subtype:message_changed' })
    expect(routeSlackEvent(msg({ subtype: 'message_deleted' }), KID).kind).toBe('ignore')
    expect(routeSlackEvent(msg({ hidden: true }), KID).kind).toBe('ignore')
    expect(routeSlackEvent(msg({ text: '   ' }), KID)).toEqual({ kind: 'ignore', reason: 'empty' })
  })

  it("ignores Fox's own messages, by installer user id or by the glasses prefix", () => {
    expect(routeSlackEvent(msg({ user: FOX }), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
    expect(routeSlackEvent(msg({ user: 'UOTHER0001', text: '〔眼镜〕今天几点放学' }), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
  })

  it('ignores everything when the Kid channel is not configured', () => {
    expect(routeSlackEvent(msg({}), undefined)).toEqual({ kind: 'ignore', reason: 'kid-channel-not-configured' })
    expect(routeSlackEvent({ type: 'app_rate_limited' }, KID).kind).toBe('ignore')
    expect(routeSlackEvent(null, KID).kind).toBe('ignore')
  })
})
