export interface ListenOptions {
  model?: string
  language?: string
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
  return `https://api.deepgram.com/v1/listen?${params.toString()}`
}

export const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' })
export const KEEP_ALIVE = JSON.stringify({ type: 'KeepAlive' })

export interface DeepgramResult {
  transcript: string
  isFinal: boolean
  speechFinal: boolean
}

export function parseDeepgramMessage(data: string): DeepgramResult | null {
  let msg: unknown
  try {
    msg = JSON.parse(data)
  } catch {
    return null
  }
  const m = msg as { type?: string; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } }
  if (m?.type !== 'Results') return null
  return {
    transcript: m.channel?.alternatives?.[0]?.transcript ?? '',
    isFinal: !!m.is_final,
    speechFinal: !!m.speech_final,
  }
}

const LATIN_END = /[A-Za-z0-9]$/
const LATIN_START = /^[A-Za-z0-9]/
const ASCII_PUNCT_END = /[.,!?;:]$/

export function joinSegments(segments: string[]): string {
  let out = ''
  for (const raw of segments) {
    const s = raw.trim()
    if (!s) continue
    const needsSpace = out !== '' && (LATIN_END.test(out) || ASCII_PUNCT_END.test(out)) && LATIN_START.test(s)
    out += needsSpace ? ` ${s}` : s
  }
  return out
}

export class TranscriptAssembler {
  private finals: string[] = []
  private interim = ''

  feed(r: DeepgramResult): { partial: string } {
    if (r.isFinal) {
      if (r.transcript.trim()) this.finals.push(r.transcript)
      this.interim = ''
    } else {
      this.interim = r.transcript
    }
    return { partial: joinSegments([...this.finals, this.interim]) }
  }

  finalText(): string {
    return joinSegments(this.finals)
  }
}

export type DeepgramConnector = (url: string, apiKey: string) => Promise<WebSocket>

export const connectDeepgram: DeepgramConnector = async (url, apiKey) => {
  const res = await fetch(url, { headers: { Upgrade: 'websocket', Authorization: `Token ${apiKey}` } })
  const ws = res.webSocket
  if (!ws) throw new Error(`deepgram upgrade failed: http ${res.status}`)
  ws.accept()
  return ws
}
