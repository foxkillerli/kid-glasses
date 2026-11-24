export const SCREEN_W = 576
export const SCREEN_H = 288
export const LINE_H = 27

export const LIMIT_CREATE = 1000
export const LIMIT_REBUILD = 1000
export const LIMIT_UPGRADE = 2000

const encoder = new TextEncoder()

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length
}

export function fitsLimit(s: string, limit: number): boolean {
  return s.length <= limit && utf8Bytes(s) <= limit
}

export function clampToLimit(s: string, limit: number): string {
  if (fitsLimit(s, limit)) return s
  const chars = Array.from(s)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fitsLimit(chars.slice(0, mid).join('') + '…', limit)) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join('') + '…'
}
