import { isWide } from './lens-text'

export const PROGRESSIVE_KID_REVEAL = false

export const READING_SPEED = { zhCharsPerSecond: 6, enCharsPerSecond: 15 } as const

export type ReadingSpeed = { zhCharsPerSecond: number; enCharsPerSecond: number }

export function charsShownAfter(text: string, elapsedMs: number, speed: ReadingSpeed = READING_SPEED): number {
  const chars = Array.from(text)
  let spent = 0
  let n = 0
  for (const ch of chars) {
    const cost = 1000 / (isWide(ch) ? speed.zhCharsPerSecond : speed.enCharsPerSecond)
    if (spent + cost > elapsedMs) break
    spent += cost
    n++
  }
  return n
}

export function revealDurationMs(text: string, speed: ReadingSpeed = READING_SPEED): number {
  let ms = 0
  for (const ch of text) ms += 1000 / (isWide(ch) ? speed.zhCharsPerSecond : speed.enCharsPerSecond)
  return ms
}
