import { isFromGlasses } from './sanitize'

export interface KidMessage {
  eventId: string
  channel: string
  user: string | null
  text: string
  ts: string
  threadTs: string | null
}

export type SlackRoute =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'kid-message'; message: KidMessage }
  | { kind: 'ignore'; reason: string }

const ALLOWED_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share', 'me_message'])

interface Authorization {
  user_id?: string
  is_bot?: boolean
}

function installerUserIds(body: Record<string, unknown>): Set<string> {
  const ids = new Set<string>()
  const auths = Array.isArray(body.authorizations) ? (body.authorizations as Authorization[]) : []
  for (const a of auths) if (a && !a.is_bot && typeof a.user_id === 'string') ids.add(a.user_id)
  return ids
}

export function routeSlackEvent(body: unknown, kidChannelId: string | undefined): SlackRoute {
  if (!body || typeof body !== 'object') return { kind: 'ignore', reason: 'not-json-object' }
  const b = body as Record<string, unknown>
  if (b.type === 'url_verification' && typeof b.challenge === 'string') return { kind: 'challenge', challenge: b.challenge }
  if (b.type !== 'event_callback') return { kind: 'ignore', reason: `type:${String(b.type)}` }
  if (!kidChannelId) return { kind: 'ignore', reason: 'kid-channel-not-configured' }
  const e = (b.event ?? {}) as Record<string, unknown>
  if (e.type !== 'message') return { kind: 'ignore', reason: `event:${String(e.type)}` }
  if (e.channel !== kidChannelId) return { kind: 'ignore', reason: 'other-channel' }
  if (e.channel_type !== undefined && e.channel_type !== 'im') return { kind: 'ignore', reason: 'not-im' }
  const subtype = e.subtype as string | undefined
  if (!ALLOWED_SUBTYPES.has(subtype)) return { kind: 'ignore', reason: `subtype:${subtype}` }
  if (e.hidden) return { kind: 'ignore', reason: 'hidden' }
  const user = typeof e.user === 'string' ? e.user : null
  const installers = installerUserIds(b)
  if (user && installers.has(user)) return { kind: 'ignore', reason: 'own-message' }
  const text = typeof e.text === 'string' ? e.text : ''
  if (installers.size === 0 && isFromGlasses(text)) return { kind: 'ignore', reason: 'own-message' }
  if (!text.trim()) return { kind: 'ignore', reason: 'empty' }
  if (typeof e.ts !== 'string') return { kind: 'ignore', reason: 'no-ts' }
  return {
    kind: 'kid-message',
    message: {
      eventId: typeof b.event_id === 'string' ? b.event_id : `ts:${e.ts}`,
      channel: kidChannelId,
      user,
      text,
      ts: e.ts,
      threadTs: typeof e.thread_ts === 'string' ? e.thread_ts : null,
    },
  }
}
