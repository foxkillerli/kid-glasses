import { utf8Bytes } from './limits'
import { paginateLines } from './paginate'

export const LENS_TEXT = {
  zhCharsPerLine: 28,
  enCharsPerLine: 52,
  bodyLines: 8,
  fullScreenLines: 10,
  pageMaxBytes: 900,
} as const

export type LensTextConfig = typeof LENS_TEXT

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3040, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

export function isWide(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0
  for (const [lo, hi] of WIDE_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

function unitsFor(cfg: LensTextConfig) {
  return { line: cfg.zhCharsPerLine * cfg.enCharsPerLine, wide: cfg.enCharsPerLine, narrow: cfg.zhCharsPerLine }
}

export function textUnits(s: string, cfg: LensTextConfig = LENS_TEXT): number {
  const u = unitsFor(cfg)
  let n = 0
  for (const ch of s) n += isWide(ch) ? u.wide : u.narrow
  return n
}

function wrapParagraph(para: string, cfg: LensTextConfig): string[] {
  const u = unitsFor(cfg)
  const out: string[] = []
  let line: string[] = []
  let width = 0
  const flush = () => {
    out.push(line.join('').trimEnd())
    line = []
    width = 0
  }
  for (const ch of para) {
    const w = isWide(ch) ? u.wide : u.narrow
    if (width + w > u.line) {
      const lastSpace = line.lastIndexOf(' ')
      if (ch !== ' ' && !isWide(ch) && lastSpace > 0 && !line.slice(lastSpace + 1).some(isWide)) {
        const carry = line.slice(lastSpace + 1)
        line = line.slice(0, lastSpace)
        flush()
        line = carry
        width = carry.reduce((a, c) => a + (isWide(c) ? u.wide : u.narrow), 0)
      } else {
        flush()
      }
      if (ch === ' ') continue
    }
    line.push(ch)
    width += w
  }
  if (line.length || out.length === 0) flush()
  return out
}

export function wrapForLens(text: string, cfg: LensTextConfig = LENS_TEXT): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .flatMap(p => wrapParagraph(p, cfg))
}

export function paginateForLens(
  text: string,
  lines: number = LENS_TEXT.bodyLines,
  cfg: LensTextConfig = LENS_TEXT,
): string[] {
  const wrapped = wrapForLens(text, cfg)
  return paginateLines(wrapped, { maxLines: lines, maxBytes: cfg.pageMaxBytes }).map(p => p.join('\n'))
}

export function fitsLensLine(s: string, cfg: LensTextConfig = LENS_TEXT): boolean {
  return textUnits(s, cfg) <= unitsFor(cfg).line && utf8Bytes(s) <= cfg.pageMaxBytes
}
