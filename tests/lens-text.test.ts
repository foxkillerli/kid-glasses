import { describe, expect, it } from 'vitest'
import { getTextWidth } from '@evenrealities/pretext'
import { LENS_TEXT, fitsLensLine, isWide, paginateForLens, textUnits, wrapForLens } from '../src/lib/lens-text'

const BODY_INNER_W = 576 - 2 * 4

describe('LENS_TEXT calibration (simulator 0.9.5 readings)', () => {
  it('uses the conservative simulator values', () => {
    expect(LENS_TEXT).toMatchObject({ zhCharsPerLine: 28, enCharsPerLine: 52, bodyLines: 8, fullScreenLines: 10 })
  })
})

describe('isWide / textUnits', () => {
  it('treats CJK, fullwidth punctuation, kana, hangul and emoji as wide', () => {
    for (const ch of ['汉', '，', '。', 'あ', '한', '０', '😀', '𠀀']) expect(isWide(ch), ch).toBe(true)
    for (const ch of ['a', 'Z', '1', ',', ' ', 'é']) expect(isWide(ch), ch).toBe(false)
  })

  it('makes 28 hanzi and 52 latin chars exactly one line', () => {
    expect(textUnits('汉'.repeat(28))).toBe(textUnits('x'.repeat(52)))
    expect(fitsLensLine('汉'.repeat(28))).toBe(true)
    expect(fitsLensLine('汉'.repeat(29))).toBe(false)
    expect(fitsLensLine('x'.repeat(52))).toBe(true)
    expect(fitsLensLine('x'.repeat(53))).toBe(false)
  })
})

describe('wrapForLens', () => {
  it('wraps Chinese at 28 chars per line', () => {
    const lines = wrapForLens('字'.repeat(60))
    expect(lines.map(l => [...l].length)).toEqual([28, 28, 4])
  })

  it('wraps English at word boundaries within 52 chars', () => {
    const text = 'the quick brown fox jumps over the lazy dog '.repeat(3).trim()
    const lines = wrapForLens(text)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(52)
    expect(lines.join(' ')).toBe(text)
    expect(lines[0].endsWith(' ')).toBe(false)
  })

  it('hard-breaks a word longer than a line', () => {
    const lines = wrapForLens('a'.repeat(120))
    expect(lines.map(l => l.length)).toEqual([52, 52, 16])
  })

  it('keeps explicit newlines and empty lines', () => {
    expect(wrapForLens('一\n\nb')).toEqual(['一', '', 'b'])
    expect(wrapForLens('')).toEqual([''])
  })

  it('mixes widths: 20 hanzi leave room for 14 latin chars', () => {
    const lines = wrapForLens('汉'.repeat(20) + 'b'.repeat(15))
    expect(lines).toEqual(['汉'.repeat(20) + 'b'.repeat(14), 'b'])
  })

  it('produces lines that fit the body width in the official pretext font model for typical text', () => {
    const samples = [
      '今天放学以后我想去公园玩，然后回家写作业，妈妈说晚饭吃饺子。明天要带水彩笔去学校画画。',
      'Can you remind me to bring my library book tomorrow? Also what time is swimming practice on Saturday?',
      '我想问一下 Saturday 的 swimming 课是几点开始的，要不要带 goggles 和毛巾？',
    ]
    for (const s of samples) for (const line of wrapForLens(s)) expect(getTextWidth(line), line).toBeLessThanOrEqual(BODY_INNER_W)
  })
})

describe('paginateForLens', () => {
  it('splits wrapped text into pages of 8 body lines', () => {
    const pages = paginateForLens('字'.repeat(28 * 20))
    expect(pages.map(p => p.split('\n').length)).toEqual([8, 8, 4])
  })

  it('supports the full-screen 10-line variant', () => {
    const pages = paginateForLens('字'.repeat(28 * 20), LENS_TEXT.fullScreenLines)
    expect(pages.map(p => p.split('\n').length)).toEqual([10, 10])
  })
})
