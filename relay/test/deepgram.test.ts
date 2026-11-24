import { describe, expect, it } from 'vitest'
import { TranscriptAssembler, buildListenUrl, joinSegments, parseDeepgramMessage } from '../src/deepgram'

describe('Deepgram streaming helpers', () => {
  it('builds a raw-PCM listen URL matching the glasses audio format', () => {
    const u = new URL(buildListenUrl())
    expect(u.origin + u.pathname).toBe('https://api.deepgram.com/v1/listen')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      model: 'nova-3',
      language: 'multi',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      endpointing: '100',
    })
    expect(new URL(buildListenUrl({ model: 'nova-2', language: 'zh-CN' })).searchParams.get('endpointing')).toBe('300')
  })

  it('parses Results messages and ignores others', () => {
    const r = parseDeepgramMessage(JSON.stringify({ type: 'Results', is_final: true, speech_final: false, channel: { alternatives: [{ transcript: '你好' }] } }))
    expect(r).toEqual({ transcript: '你好', isFinal: true, speechFinal: false })
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata' }))).toBeNull()
    expect(parseDeepgramMessage('not json')).toBeNull()
  })

  it('joins Chinese without spaces and English with spaces', () => {
    expect(joinSegments(['今天', '下雨了'])).toBe('今天下雨了')
    expect(joinSegments(['hello', 'world'])).toBe('hello world')
    expect(joinSegments(['OK.', 'Bye'])).toBe('OK. Bye')
    expect(joinSegments(['我要去', 'Park', '玩'])).toBe('我要去Park玩')
  })

  it('assembles interim and final results', () => {
    const a = new TranscriptAssembler()
    expect(a.feed({ transcript: '今天', isFinal: false, speechFinal: false }).partial).toBe('今天')
    expect(a.feed({ transcript: '今天几点', isFinal: true, speechFinal: false }).partial).toBe('今天几点')
    expect(a.feed({ transcript: '放学', isFinal: false, speechFinal: false }).partial).toBe('今天几点放学')
    a.feed({ transcript: '放学？', isFinal: true, speechFinal: true })
    expect(a.finalText()).toBe('今天几点放学？')
  })
})
