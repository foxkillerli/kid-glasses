export type AsrLang = 'auto' | 'zh' | 'en'
export const ASR_LANGS: readonly AsrLang[] = ['auto', 'zh', 'en']

export interface ListenOptions {
  model?: string
  language?: string
  hints?: string[]
}

export interface ListenConfig {
  model?: string
  language?: string
  hints?: string
}

const HINT_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/
export const DEFAULT_HINTS = 'zh,en'

export function parseHints(raw: string | undefined): string[] {
  const list = (raw ?? DEFAULT_HINTS)
    .split(',')
    .map(s => s.trim())
    .filter(s => HINT_RE.test(s))
  return [...new Set(list)].slice(0, 5)
}

export function listenOptionsFor(lang: AsrLang, cfg: ListenConfig = {}, fallback = false): ListenOptions {
  const model = cfg.model || 'nova-3'
  if (fallback) return { model, language: 'multi' }
  if (lang === 'zh') return { model, language: 'zh-CN' }
  if (lang === 'en') return { model, language: 'en' }
  const language = cfg.language || 'multi'
  return language === 'multi' ? { model, language, hints: parseHints(cfg.hints) } : { model, language }
}

export function buildListenUrl(o: ListenOptions = {}): string {
  const language = o.language || 'multi'
  const params = new URLSearchParams({
    model: o.model || 'nova-3',
    language,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: language === 'multi' ? '100' : '300',
  })
  if (language === 'multi') for (const h of o.hints ?? []) params.append('language_hint', h)
  return `https://api.deepgram.com/v1/listen?${params.toString()}`
}

export const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' })
export const KEEP_ALIVE = JSON.stringify({ type: 'KeepAlive' })
export const FINALIZE = JSON.stringify({ type: 'Finalize' })

export interface DeepgramResult {
  kind: 'results'
  transcript: string
  isFinal: boolean
  speechFinal: boolean
  fromFinalize: boolean
  start: number
  duration: number
}

export type DeepgramMessage = DeepgramResult | { kind: 'metadata' } | { kind: 'utterance-end' } | { kind: 'error' } | { kind: 'other' }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export function parseDeepgramEvent(data: string): DeepgramMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(data)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object') return null
  const m = msg as {
    type?: string
    is_final?: boolean
    speech_final?: boolean
    from_finalize?: boolean
    start?: unknown
    duration?: unknown
    channel?: { alternatives?: Array<{ transcript?: string }> }
  }
  switch (m.type) {
    case 'Results':
      return {
        kind: 'results',
        transcript: typeof m.channel?.alternatives?.[0]?.transcript === 'string' ? m.channel.alternatives[0].transcript : '',
        isFinal: !!m.is_final,
        speechFinal: !!m.speech_final,
        fromFinalize: !!m.from_finalize,
        start: num(m.start),
        duration: num(m.duration),
      }
    case 'Metadata':
      return { kind: 'metadata' }
    case 'UtteranceEnd':
      return { kind: 'utterance-end' }
    case 'Error':
      return { kind: 'error' }
    default:
      return { kind: 'other' }
  }
}

export function parseDeepgramMessage(data: string): DeepgramResult | null {
  const e = parseDeepgramEvent(data)
  return e && e.kind === 'results' ? e : null
}

const CJK = '\\p{Script=Han}\\u3000-\\u303f\\uff00-\\uffef'
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'gu')

export function tidyCjk(s: string): string {
  return s.replace(CJK_GAP, '')
}

const LATIN_END = /[A-Za-z0-9]$/
const LATIN_START = /^[A-Za-z0-9]/
const ASCII_PUNCT_END = /[.,!?;:]$/

export function joinSegments(segments: string[]): string {
  let out = ''
  for (const raw of segments) {
    const s = tidyCjk(raw.trim())
    if (!s) continue
    const needsSpace = out !== '' && (LATIN_END.test(out) || ASCII_PUNCT_END.test(out)) && LATIN_START.test(s)
    out += needsSpace ? ` ${s}` : s
  }
  return out
}

export class TranscriptAssembler {
  private finals: string[] = []
  private interim = ''

  feed(r: Pick<DeepgramResult, 'transcript' | 'isFinal'>): { partial: string } {
    if (r.isFinal) {
      if (r.transcript.trim()) this.finals.push(r.transcript)
      this.interim = ''
    } else {
      this.interim = r.transcript
    }
    return { partial: this.partial() }
  }

  partial(): string {
    return joinSegments([...this.finals, this.interim])
  }

  finalText(): string {
    return joinSegments(this.finals)
  }
}

export class DeepgramUpgradeError extends Error {
  constructor(readonly status: number) {
    super(`deepgram upgrade failed: http ${status}`)
    this.name = 'DeepgramUpgradeError'
  }
}

export type DeepgramConnector = (url: string, apiKey: string, signal?: AbortSignal) => Promise<WebSocket>

export const connectDeepgram: DeepgramConnector = async (url, apiKey, signal) => {
  const res = await fetch(url, { headers: { Upgrade: 'websocket', Authorization: `Token ${apiKey}` }, signal })
  const ws = res.webSocket
  if (!ws) throw new DeepgramUpgradeError(res.status)
  ws.accept()
  return ws
}
