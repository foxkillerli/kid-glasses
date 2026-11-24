import { GLASSES_PREFIX } from './sanitize'

export type KidMessageKind = 'message' | 'edit' | 'file'

export interface KidMessage {
  eventId: string
  channel: string
  user: string | null
  botId: string | null
  text: string
  ts: string
  threadTs: string | null
  kind: KidMessageKind
  verifiedKid: boolean
}

export interface KidAllowlist {
  botId?: string
  userId?: string
}

export type SlackRoute =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'kid-message'; message: KidMessage }
  | { kind: 'pair-confirm'; code: string; user: string; eventId: string; atMs: number }
  | { kind: 'pair-revoke'; user: string; eventId: string; atMs: number }
  | { kind: 'ignore'; reason: string }

const PLAIN_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'me_message'])

interface Authorization {
  user_id?: string
  is_bot?: boolean
}

type Obj = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function installerUserIds(body: Obj): Set<string> {
  const ids = new Set<string>()
  const auths = Array.isArray(body.authorizations) ? (body.authorizations as Authorization[]) : []
  for (const a of auths) if (a && !a.is_bot && typeof a.user_id === 'string') ids.add(a.user_id)
  return ids
}

function attachmentText(m: Obj): string {
  const atts = Array.isArray(m.attachments) ? (m.attachments as Obj[]) : []
  return atts
    .filter(a => !a.from_url && !a.is_app_unfurl)
    .map(a => str(a.text) ?? str(a.fallback) ?? '')
    .filter(Boolean)
    .join('\n')
}

function filePlaceholder(m: Obj): string {
  const files = Array.isArray(m.files) ? (m.files as Obj[]) : []
  const names = files.map(f => str(f.name) ?? str(f.title)).filter((n): n is string => !!n)
  return names.length ? `[文件: ${names.join(', ')}]` : '[文件]'
}

export function effectiveText(m: Obj): string {
  return str(m.text) ?? attachmentText(m)
}

export const PAIR_CONFIRM_RE = /^\s*配对\s*(\d{6})\s*$/
export const PAIR_REVOKE_RE = /^\s*撤销配对\s*$/

function pairCommand(b: Obj, e: Obj): SlackRoute | null {
  const text = typeof e.text === 'string' ? e.text : ''
  const confirm = PAIR_CONFIRM_RE.exec(text)
  const revoke = PAIR_REVOKE_RE.test(text)
  if (!confirm && !revoke) return null
  const appMarked = e.subtype !== undefined || e.bot_id !== undefined || e.app_id !== undefined || e.bot_profile !== undefined || !!e.hidden
  if (appMarked) return { kind: 'ignore', reason: 'pair-app-marked' }
  const user = str(e.user)
  if (!user) return { kind: 'ignore', reason: 'pair-no-user' }
  const installers = installerUserIds(b)
  if (installers.size > 0 && !installers.has(user)) return { kind: 'ignore', reason: 'pair-not-installer' }
  const ts = str(e.ts)
  const atMs = ts ? Math.round(Number(ts) * 1000) : NaN
  if (!ts || !Number.isFinite(atMs)) return { kind: 'ignore', reason: 'pair-no-ts' }
  const eventId = `pair:${ts}`
  return confirm ? { kind: 'pair-confirm', code: confirm[1], user, eventId, atMs } : { kind: 'pair-revoke', user, eventId, atMs }
}

export function startsWithGlassesPrefix(text: string): boolean {
  return text.trimStart().startsWith(GLASSES_PREFIX)
}

export function routeSlackEvent(body: unknown, kidChannelId: string | undefined, allow: KidAllowlist = {}): SlackRoute {
  if (!body || typeof body !== 'object') return { kind: 'ignore', reason: 'not-json-object' }
  const b = body as Obj
  if (b.type === 'url_verification' && typeof b.challenge === 'string') return { kind: 'challenge', challenge: b.challenge }
  if (b.type !== 'event_callback') return { kind: 'ignore', reason: `type:${String(b.type)}` }
  if (!kidChannelId) return { kind: 'ignore', reason: 'kid-channel-not-configured' }
  const e = (b.event ?? {}) as Obj
  if (e.type !== 'message') return { kind: 'ignore', reason: `event:${String(e.type)}` }
  if (e.channel !== kidChannelId) return { kind: 'ignore', reason: 'other-channel' }
  if (e.channel_type !== undefined && e.channel_type !== 'im') return { kind: 'ignore', reason: 'not-im' }

  const pair = pairCommand(b, e)
  if (pair) return pair

  const subtype = e.subtype as string | undefined
  let m: Obj
  let kind: KidMessageKind
  if (subtype === 'message_deleted') return { kind: 'ignore', reason: 'deleted' }
  if (subtype === 'message_changed') {
    if (!e.message || typeof e.message !== 'object') return { kind: 'ignore', reason: 'edit-without-message' }
    m = e.message as Obj
    const prev = e.previous_message && typeof e.previous_message === 'object' ? (e.previous_message as Obj) : null
    if (prev && effectiveText(m) === effectiveText(prev)) return { kind: 'ignore', reason: 'edit-unchanged' }
    kind = 'edit'
  } else if (subtype === 'file_share') {
    m = e
    kind = 'file'
  } else if (PLAIN_SUBTYPES.has(subtype)) {
    if (e.hidden) return { kind: 'ignore', reason: 'hidden' }
    m = e
    kind = 'message'
  } else {
    return { kind: 'ignore', reason: `subtype:${subtype}` }
  }

  const user = str(m.user)
  const botId = str(m.bot_id)
  if (user && installerUserIds(b).has(user)) return { kind: 'ignore', reason: 'own-message' }
  let text = effectiveText(m)
  const pinned = !!(allow.botId || allow.userId)
  const verifiedKid = pinned && ((!!allow.botId && botId === allow.botId) || (!!allow.userId && user === allow.userId))
  if (pinned && !verifiedKid) return { kind: 'ignore', reason: 'not-kid' }
  if (!verifiedKid && startsWithGlassesPrefix(text)) return { kind: 'ignore', reason: 'glasses-echo' }
  if (kind === 'file') text = text.trim() ? `${text}\n${filePlaceholder(m)}` : filePlaceholder(m)
  if (!text.trim()) return { kind: 'ignore', reason: 'empty' }
  const ts = str(m.ts)
  if (!ts) return { kind: 'ignore', reason: 'no-ts' }
  const eventId = str(b.event_id) ?? `${kind}:${ts}:${str(e.event_ts) ?? ''}`
  return {
    kind: 'kid-message',
    message: { eventId, channel: kidChannelId, user, botId, text, ts, threadTs: str(m.thread_ts), kind, verifiedKid },
  }
}
