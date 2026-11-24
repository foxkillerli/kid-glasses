import { utf8Bytes } from './limits'

export interface PaginateOptions {
  maxLines: number
  maxBytes: number
}

export function paginateLines(lines: string[], opts: PaginateOptions): string[][] {
  if (opts.maxLines < 1) throw new Error('maxLines must be >= 1')
  const pages: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const line of lines) {
    const lineBytes = utf8Bytes(line) + 1
    if (lineBytes > opts.maxBytes) throw new Error(`line exceeds maxBytes: ${line.slice(0, 20)}`)
    if (current.length > 0 && (current.length >= opts.maxLines || bytes + lineBytes > opts.maxBytes)) {
      pages.push(current)
      current = []
      bytes = 0
    }
    current.push(line)
    bytes += lineBytes
  }
  if (current.length > 0) pages.push(current)
  return pages
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error('size must be >= 1')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
