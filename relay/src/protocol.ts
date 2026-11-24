export const MAX_SAY_CHARS = 2000

export type Speaker = 'kid' | 'glasses' | 'fast'

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'hello'; lastSeq?: number }
  | { t: 'ping' }
  | { t: 'say'; text: string }
  | { t: 'audio.start' }
  | { t: 'audio.stop' }
  | { t: 'history'; before?: number; limit?: number }
  | { t: 'session.new' }

export type ServerMessage =
  | { t: 'auth.ok' }
  | { t: 'hello'; session: string; lastSeq: number; fastLane: boolean }
  | { t: 'pong' }
  | { t: 'msg'; seq: number; from: Speaker; text: string; at: number; session: string | null; edited?: boolean }
  | { t: 'asr.partial'; text: string }
  | { t: 'asr.final'; text: string }
  | { t: 'posted'; seq: number; text: string }
  | { t: 'kid-webhook'; seq: number; result: 'ok' | 'skipped' | 'failed'; status: number | null }
  | { t: 'history'; items: Array<{ seq: number; from: Speaker; text: string; at: number; session: string | null; edited?: boolean }>; more: boolean }
  | { t: 'error'; code: string; message: string }

export type Parsed = { ok: true; msg: ClientMessage } | { ok: false; error: string }

const nonNegInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0

export function parseClientMessage(data: string): Parsed {
  let m: unknown
  try {
    m = JSON.parse(data)
  } catch {
    return { ok: false, error: 'not-json' }
  }
  if (!m || typeof m !== 'object') return { ok: false, error: 'not-object' }
  const o = m as Record<string, unknown>
  switch (o.t) {
    case 'auth':
      return typeof o.token === 'string' ? { ok: true, msg: { t: 'auth', token: o.token } } : { ok: false, error: 'bad-token' }
    case 'hello':
      return o.lastSeq === undefined || nonNegInt(o.lastSeq)
        ? { ok: true, msg: { t: 'hello', lastSeq: o.lastSeq as number | undefined } }
        : { ok: false, error: 'bad-lastSeq' }
    case 'ping':
    case 'audio.start':
    case 'audio.stop':
    case 'session.new':
      return { ok: true, msg: { t: o.t } }
    case 'say':
      if (typeof o.text !== 'string' || !o.text.trim()) return { ok: false, error: 'empty-text' }
      if (o.text.length > MAX_SAY_CHARS) return { ok: false, error: 'text-too-long' }
      return { ok: true, msg: { t: 'say', text: o.text } }
    case 'history':
      if (o.before !== undefined && !nonNegInt(o.before)) return { ok: false, error: 'bad-before' }
      if (o.limit !== undefined && !nonNegInt(o.limit)) return { ok: false, error: 'bad-limit' }
      return { ok: true, msg: { t: 'history', before: o.before as number | undefined, limit: o.limit as number | undefined } }
    default:
      return { ok: false, error: 'unknown-type' }
  }
}
