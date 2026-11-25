import { describe, expect, it } from 'vitest'
import { routeSlackEvent } from '../src/slack-events'

const KID = 'D0123ABCDEF'
const FOX = 'UFOX12345'
const KID_BOT = 'B0KIDBOT01'
const KID_BOT_USER = 'U0KIDBOT01'

function env(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    event_id: 'Ev1',
    authorizations: [{ user_id: FOX, is_bot: false }],
    event: { type: 'message', channel: KID, channel_type: 'im', ...event },
    ...extra,
  }
}

const kidBot = { subtype: 'bot_message', bot_id: KID_BOT, text: '三点放学', ts: '1700000000.000200' }

describe('routeSlackEvent: bot-DM model', () => {
  it('answers url_verification with the challenge', () => {
    expect(routeSlackEvent({ type: 'url_verification', challenge: 'abc123' }, KID)).toEqual({ kind: 'challenge', challenge: 'abc123' })
  })

  it('forwards a Kid bot reply (bot_message with bot_id), keeping thread_ts', () => {
    const r = routeSlackEvent(env({ ...kidBot, thread_ts: '1700000000.000100' }), KID)
    expect(r).toEqual({
      kind: 'kid-message',
      message: { eventId: 'Ev1', channel: KID, user: null, botId: KID_BOT, text: '三点放学', ts: '1700000000.000200', threadTs: '1700000000.000100', kind: 'message', verifiedKid: false },
    })
  })

  it('forwards a Kid bot reply that carries a bot user id and no subtype', () => {
    const r = routeSlackEvent(env({ user: KID_BOT_USER, bot_id: KID_BOT, text: 'ok', ts: '1.2' }), KID)
    expect(r).toMatchObject({ kind: 'kid-message', message: { user: KID_BOT_USER, botId: KID_BOT, kind: 'message' } })
  })

  it('uses attachment text when a bot message has no top-level text', () => {
    const r = routeSlackEvent(env({ subtype: 'bot_message', bot_id: KID_BOT, text: '', attachments: [{ fallback: '明天带伞' }], ts: '1.3' }), KID)
    expect(r).toMatchObject({ kind: 'kid-message', message: { text: '明天带伞' } })
  })

  it('only considers the Kid DM channel', () => {
    expect(routeSlackEvent(env({ ...kidBot, channel: 'D9999999999' }), KID)).toEqual({ kind: 'ignore', reason: 'other-channel' })
    expect(routeSlackEvent(env({ ...kidBot, channel: 'C0123ABCDEF', channel_type: 'channel' }), KID)).toEqual({ kind: 'ignore', reason: 'other-channel' })
    expect(routeSlackEvent(env(kidBot), undefined)).toEqual({ kind: 'ignore', reason: 'kid-channel-not-configured' })
  })

  it("never echoes Fox's own messages: by installer id, and by the 〔眼镜〕 prefix", () => {
    expect(routeSlackEvent(env({ user: FOX, text: 'hi', ts: '1.4' }), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
    expect(routeSlackEvent(env({ user: 'UOTHER0001', text: '〔眼镜〕今天几点放学', ts: '1.5' }, { authorizations: [] }), KID)).toEqual({ kind: 'ignore', reason: 'glasses-echo' })
    expect(routeSlackEvent(env({ ...kidBot, text: '  〔眼镜〕quoted' }), KID)).toEqual({ kind: 'ignore', reason: 'glasses-echo' })
  })

  it('forwards an edit of a Kid reply as kind "edit", using the new text and the original ts', () => {
    const r = routeSlackEvent(
      env({
        subtype: 'message_changed',
        hidden: true,
        message: { ...kidBot, text: '三点半放学', thread_ts: '1700000000.000100' },
        previous_message: { ...kidBot },
      }),
      KID,
    )
    expect(r).toMatchObject({ kind: 'kid-message', message: { kind: 'edit', text: '三点半放学', ts: '1700000000.000200', threadTs: '1700000000.000100', botId: KID_BOT } })
  })

  it('ignores edits that do not change the text (unfurls), edits by Fox, and deletes', () => {
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: { ...kidBot }, previous_message: { ...kidBot } }), KID)).toEqual({ kind: 'ignore', reason: 'edit-unchanged' })
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: { user: FOX, text: 'b', ts: '1' }, previous_message: { user: FOX, text: 'a' } }), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: { user: FOX, text: '〔眼镜〕b', ts: '1' }, previous_message: { text: '〔眼镜〕a' } }, { authorizations: [] }), KID)).toEqual({ kind: 'ignore', reason: 'glasses-echo' })
    expect(routeSlackEvent(env({ subtype: 'message_deleted', deleted_ts: '1.2', previous_message: kidBot }), KID)).toEqual({ kind: 'ignore', reason: 'deleted' })
    expect(routeSlackEvent(env({ subtype: 'message_changed' }), KID)).toEqual({ kind: 'ignore', reason: 'edit-without-message' })
  })

  it('shows a short placeholder for file shares', () => {
    expect(routeSlackEvent(env({ subtype: 'file_share', user: KID_BOT_USER, text: '', files: [{ name: 'homework.pdf' }], ts: '1.6' }), KID)).toMatchObject({
      kind: 'kid-message',
      message: { kind: 'file', text: '[文件: homework.pdf]' },
    })
    expect(routeSlackEvent(env({ subtype: 'file_share', user: KID_BOT_USER, text: '看这个', files: [{}], ts: '1.7' }), KID)).toMatchObject({
      message: { text: '看这个\n[文件]' },
    })
  })

  it('forwards thread_broadcast once as a normal message with its thread_ts', () => {
    expect(routeSlackEvent(env({ ...kidBot, subtype: 'thread_broadcast', thread_ts: '1.0' }), KID)).toMatchObject({ kind: 'kid-message', message: { kind: 'message', threadTs: '1.0' } })
  })

  it('ignores joins, hidden plain messages, empty text and unknown event types', () => {
    expect(routeSlackEvent(env({ subtype: 'channel_join', user: 'U1', text: 'joined', ts: '1' }), KID).kind).toBe('ignore')
    expect(routeSlackEvent(env({ ...kidBot, hidden: true }), KID)).toEqual({ kind: 'ignore', reason: 'hidden' })
    expect(routeSlackEvent(env({ ...kidBot, text: '   ' }), KID)).toEqual({ kind: 'ignore', reason: 'empty' })
    expect(routeSlackEvent(env({ type: 'reaction_added' }), KID).kind).toBe('ignore')
    expect(routeSlackEvent(null, KID).kind).toBe('ignore')
  })

  it('with an allowlist (KID_BOT_ID / KID_BOT_USER_ID), forwards only the pinned Kid identity', () => {
    expect(routeSlackEvent(env(kidBot), KID, { botId: KID_BOT }).kind).toBe('kid-message')
    expect(routeSlackEvent(env({ ...kidBot, bot_id: 'BOTHER0001' }), KID, { botId: KID_BOT })).toEqual({ kind: 'ignore', reason: 'not-kid' })
    expect(routeSlackEvent(env({ user: 'USOMEONE01', text: 'x', ts: '1' }), KID, { botId: KID_BOT })).toEqual({ kind: 'ignore', reason: 'not-kid' })
    expect(routeSlackEvent(env({ user: KID_BOT_USER, text: 'x', ts: '1' }), KID, { userId: KID_BOT_USER }).kind).toBe('kid-message')
  })

  it('with both pins set (as deployed for KK), accepts the pinned bot id or bot user, and rejects any other bot or person', () => {
    const both = { botId: KID_BOT, userId: KID_BOT_USER }
    expect(routeSlackEvent(env(kidBot), KID, both)).toMatchObject({ kind: 'kid-message', message: { verifiedKid: true } })
    expect(routeSlackEvent(env({ ...kidBot, user: KID_BOT_USER }), KID, both)).toMatchObject({ kind: 'kid-message', message: { verifiedKid: true } })
    expect(routeSlackEvent(env({ user: KID_BOT_USER, text: 'x', ts: '1' }), KID, both)).toMatchObject({ kind: 'kid-message', message: { verifiedKid: true } })
    expect(routeSlackEvent(env({ ...kidBot, bot_id: 'B0OLDBOT001' }), KID, both)).toEqual({ kind: 'ignore', reason: 'not-kid' })
    expect(routeSlackEvent(env({ ...kidBot, bot_id: 'B0OLDBOT001', user: 'U0OLDBOT001' }), KID, both)).toEqual({ kind: 'ignore', reason: 'not-kid' })
    expect(routeSlackEvent(env({ user: 'USOMEONE01', text: 'x', ts: '1' }), KID, both)).toEqual({ kind: 'ignore', reason: 'not-kid' })
    expect(routeSlackEvent(env({ user: FOX, text: 'x', ts: '1' }), KID, both)).toEqual({ kind: 'ignore', reason: 'own-message' })
  })

  it('F1: with a pinned Kid identity, a verified Kid reply starting with 〔眼镜〕 is still forwarded', () => {
    const r = routeSlackEvent(env({ ...kidBot, text: '〔眼镜〕我刚收到这条' }), KID, { botId: KID_BOT })
    expect(r).toMatchObject({ kind: 'kid-message', message: { verifiedKid: true, text: '〔眼镜〕我刚收到这条' } })
    expect(routeSlackEvent(env({ user: 'UOTHER0001', text: '〔眼镜〕x', ts: '1' }), KID, { botId: KID_BOT })).toEqual({ kind: 'ignore', reason: 'not-kid' })
  })

  it('F2: compares the delivered text of an edit, including attachment-only text, and ignores unfurl attachments', () => {
    const before = { subtype: 'bot_message', bot_id: KID_BOT, text: '', attachments: [{ fallback: '三点' }], ts: '1.9' }
    const after = { ...before, attachments: [{ fallback: '三点半' }] }
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: after, previous_message: before }), KID)).toMatchObject({ kind: 'kid-message', message: { kind: 'edit', text: '三点半' } })
    const unfurled = { ...kidBot, attachments: [{ from_url: 'https://x.y', fallback: 'preview' }] }
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: unfurled, previous_message: kidBot }), KID)).toEqual({ kind: 'ignore', reason: 'edit-unchanged' })
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: { ...kidBot } }), KID)).toMatchObject({ kind: 'kid-message', message: { kind: 'edit' } })
  })
})

describe('routeSlackEvent: pairing commands', () => {
  const fox = (text: string, extra: Record<string, unknown> = {}) => env({ user: FOX, text, ts: '1.1', ...extra })

  it('routes a plain message from Fox "配对 123456" as pair-confirm', () => {
    expect(routeSlackEvent(fox('配对 123456'), KID)).toEqual({ kind: 'pair-confirm', code: '123456', user: FOX, eventId: 'pair:1.1', atMs: 1100 })
    expect(routeSlackEvent(fox(' 配对123456 '), KID)).toMatchObject({ kind: 'pair-confirm', code: '123456' })
    expect(routeSlackEvent(fox('撤销配对'), KID)).toEqual({ kind: 'pair-revoke', user: FOX, eventId: 'pair:1.1', atMs: 1100 })
  })

  it('rejects app-marked or subtyped messages, so the relay\'s own user-token posts can never confirm', () => {
    for (const extra of [{ app_id: 'A1' }, { bot_id: 'B1' }, { bot_profile: { id: 'B1' } }, { subtype: 'bot_message' }, { subtype: 'thread_broadcast' }, { hidden: true }]) {
      expect(routeSlackEvent(fox('配对 123456', extra), KID)).toEqual({ kind: 'ignore', reason: 'pair-app-marked' })
    }
    expect(routeSlackEvent(env({ subtype: 'message_changed', message: { user: FOX, text: '配对 123456', ts: '1' }, previous_message: { text: 'x' } }), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
  })

  it('rejects someone other than the installing user, other channels, and wrong formats', () => {
    expect(routeSlackEvent(env({ user: 'UOTHER0001', text: '配对 123456', ts: '1' }), KID)).toEqual({ kind: 'ignore', reason: 'pair-not-installer' })
    expect(routeSlackEvent(fox('配对 123456', { channel: 'D9999999999' }), KID)).toEqual({ kind: 'ignore', reason: 'other-channel' })
    expect(routeSlackEvent(fox('配对 12345'), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
    expect(routeSlackEvent(fox('请配对 123456'), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
    expect(routeSlackEvent(fox('配对 １２３４５６'), KID)).toEqual({ kind: 'ignore', reason: 'own-message' })
  })
})
