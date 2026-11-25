import { describe, expect, it } from 'vitest'
import { TranscriptAssembler, buildListenUrl, joinSegments, listenOptionsFor, parseDeepgramEvent, parseDeepgramMessage, parseHints, tidyCjk } from '../src/deepgram'

const params = (lang: 'auto' | 'zh' | 'en', cfg = {}, fallback = false) => {
  const u = new URL(buildListenUrl(listenOptionsFor(lang, cfg, fallback)))
  return { base: u.origin + u.pathname, all: Object.fromEntries(u.searchParams), hints: u.searchParams.getAll('language_hint') }
}

describe('Deepgram streaming helpers', () => {
  it('builds a raw-PCM listen URL matching the glasses audio format', () => {
    const p = params('auto')
    expect(p.base).toBe('https://api.deepgram.com/v1/listen')
    expect(p.all).toMatchObject({
      model: 'nova-3',
      language: 'multi',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: '100',
    })
    expect(p.all).not.toHaveProperty('utterance_end_ms')
    expect(p.hints).toEqual(['zh', 'en'])
  })

  it('maps the per-turn language: auto → multi + hints, zh → zh-CN, en → en; monolingual uses endpointing 300 and no hints', () => {
    expect(params('zh').all).toMatchObject({ model: 'nova-3', language: 'zh-CN', endpointing: '300' })
    expect(params('zh').hints).toEqual([])
    expect(params('en').all).toMatchObject({ language: 'en', endpointing: '300' })
    expect(params('en').hints).toEqual([])
    expect(params('auto', { model: 'nova-2', language: 'zh-TW' }).all).toMatchObject({ model: 'nova-2', language: 'zh-TW', endpointing: '300' })
    expect(params('auto', { hints: 'en, ja ,BAD!,zh-CN' }).hints).toEqual(['en', 'ja', 'zh-CN'])
  })

  it('the fallback URL is the M1 config: multi without hints', () => {
    const p = params('zh', { hints: 'zh,en' }, true)
    expect(p.all).toMatchObject({ model: 'nova-3', language: 'multi', endpointing: '100' })
    expect(p.hints).toEqual([])
  })

  it('validates hint codes and caps them', () => {
    expect(parseHints(undefined)).toEqual(['zh', 'en'])
    expect(parseHints('')).toEqual([])
    expect(parseHints('zh,zh,en,fr,de,es,it,ja')).toEqual(['zh', 'en', 'fr', 'de', 'es'])
    expect(parseHints('en&x=1,zh')).toEqual(['zh'])
  })

  it('parses Results with timing and finalize flag, Metadata and UtteranceEnd', () => {
    const r = parseDeepgramMessage(
      JSON.stringify({ type: 'Results', is_final: true, speech_final: false, from_finalize: true, start: 1.5, duration: 0.75, channel: { alternatives: [{ transcript: '你好' }] } }),
    )
    expect(r).toEqual({ kind: 'results', transcript: '你好', isFinal: true, speechFinal: false, fromFinalize: true, start: 1.5, duration: 0.75 })
    expect(parseDeepgramEvent(JSON.stringify({ type: 'Metadata', duration: 3 }))).toEqual({ kind: 'metadata' })
    expect(parseDeepgramEvent(JSON.stringify({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 2.3 }))).toEqual({ kind: 'utterance-end' })
    expect(parseDeepgramEvent(JSON.stringify({ type: 'SpeechStarted' }))).toEqual({ kind: 'other' })
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata' }))).toBeNull()
    expect(parseDeepgramMessage('not json')).toBeNull()
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Results', start: -1, duration: 'x' }))).toMatchObject({ transcript: '', start: 0, duration: 0 })
  })

  it('removes spaces between CJK characters but keeps them around Latin words', () => {
    expect(tidyCjk('今天 几点 放学 ？')).toBe('今天几点放学？')
    expect(tidyCjk('我 要 去 Park 玩')).toBe('我要去 Park 玩')
    expect(tidyCjk('hello world')).toBe('hello world')
  })

  it('joins Chinese without spaces and English with spaces', () => {
    expect(joinSegments(['今天', '下雨了'])).toBe('今天下雨了')
    expect(joinSegments(['hello', 'world'])).toBe('hello world')
    expect(joinSegments(['OK.', 'Bye'])).toBe('OK. Bye')
    expect(joinSegments(['我要去', 'Park', '玩'])).toBe('我要去Park玩')
    expect(joinSegments(['今天 下雨', '了 吗'])).toBe('今天下雨了吗')
  })

  it('assembles interim and final results', () => {
    const a = new TranscriptAssembler()
    expect(a.feed({ transcript: '今天', isFinal: false }).partial).toBe('今天')
    expect(a.feed({ transcript: '今天几点', isFinal: true }).partial).toBe('今天几点')
    expect(a.feed({ transcript: '放学', isFinal: false }).partial).toBe('今天几点放学')
    expect(a.finalText()).toBe('今天几点')
    a.feed({ transcript: '放学？', isFinal: true })
    expect(a.finalText()).toBe('今天几点放学？')
    expect(a.partial()).toBe('今天几点放学？')
  })
})
