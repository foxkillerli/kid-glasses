import { ASR_LANGS, type AsrLang } from './deepgram'

export const MAX_SAY_CHARS = 2000
export const CID_RE = /^[A-Za-z0-9_-]{8,64}$/

export type Speaker = 'kid' | 'glasses' | 'fast'

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'hello'; lastSeq?: number }
  | { t: 'ping' }
  | { t: 'say'; text: string; cid?: string }
  | { t: 'audio.start'; cid?: string; lang?: AsrLang }
  | { t: 'audio.stop' }
  | { t: 'audio.cancel' }
  | { t: 'history'; before?: number; limit?: number }
  | { t: 'session.new' }

export type ServerMessage =
  | { t: 'auth.ok' }
  | { t: 'hello'; session: string; lastSeq: number; fastLane: boolean }
  | { t: 'pong' }
  | { t: 'replay.done'; upTo: number }
  | ({ t: 'msg' } & WireItem)
  | { t: 'asr.partial'; text: string; cid?: string }
  | { t: 'asr.final'; text: string; cid?: string }
  | { t: 'posted'; seq: number; text: string; cid?: string; dup?: boolean }
  | { t: 'kid-webhook'; seq: number; result: 'ok' | 'skipped' | 'failed'; status: number | null }
  | { t: 'history'; items: WireItem[]; more: boolean }
  | { t: 'turn.pending'; cid: string; text: string }
  | { t: 'error'; code: string; message: string; cid?: string }

export interface WireItem {
  seq: number
  from: Speaker
  text: string
  at: number
  session: string | null
  edited?: boolean
  cid?: string
}

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
    case 'audio.start':
      if (o.cid !== undefined && (typeof o.cid !== 'string' || !CID_RE.test(o.cid))) return { ok: false, error: 'bad-cid' }
      if (o.lang !== undefined && !ASR_LANGS.includes(o.lang as AsrLang)) return { ok: false, error: 'bad-lang' }
      return { ok: true, msg: { t: 'audio.start', ...(o.cid ? { cid: o.cid as string } : {}), ...(o.lang ? { lang: o.lang as AsrLang } : {}) } }
    case 'ping':
    case 'audio.stop':
    case 'audio.cancel':
    case 'session.new':
      return { ok: true, msg: { t: o.t as 'ping' | 'audio.stop' | 'audio.cancel' | 'session.new' } }
    case 'say':
      if (typeof o.text !== 'string' || !o.text.trim()) return { ok: false, error: 'empty-text' }
      if (o.text.length > MAX_SAY_CHARS) return { ok: false, error: 'text-too-long' }
      if (o.cid !== undefined && (typeof o.cid !== 'string' || !CID_RE.test(o.cid))) return { ok: false, error: 'bad-cid' }
      return { ok: true, msg: o.cid ? { t: 'say', text: o.text, cid: o.cid as string } : { t: 'say', text: o.text } }
    case 'history':
      if (o.before !== undefined && !nonNegInt(o.before)) return { ok: false, error: 'bad-before' }
      if (o.limit !== undefined && !nonNegInt(o.limit)) return { ok: false, error: 'bad-limit' }
      return { ok: true, msg: { t: 'history', before: o.before as number | undefined, limit: o.limit as number | undefined } }
    default:
      return { ok: false, error: 'unknown-type' }
  }
}
