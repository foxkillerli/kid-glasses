export const SAMPLE_RATE = 16000
export const BYTES_PER_SAMPLE = 2

export function bytesToSeconds(bytes: number): number {
  return bytes / (SAMPLE_RATE * BYTES_PER_SAMPLE)
}

export function rms(samples: Int16Array, start = 0, end = samples.length): number {
  const n = end - start
  if (n <= 0) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    const v = samples[i]
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

export function peak(samples: Int16Array, start = 0, end = samples.length): number {
  let p = 0
  for (let i = start; i < end; i++) {
    const v = Math.abs(samples[i])
    if (v > p) p = v
  }
  return p
}

export function toDbfs(amplitude: number): number {
  if (amplitude <= 0) return -Infinity
  return 20 * Math.log10(amplitude / 32768)
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-inf'
  return db.toFixed(1)
}

export function levelBar(db: number, cells = 16, floorDb = -60): string {
  const frac = Number.isFinite(db) ? Math.min(1, Math.max(0, (db - floorDb) / -floorDb)) : 0
  const filled = Math.round(frac * cells)
  return '█'.repeat(filled) + '─'.repeat(cells - filled)
}

export class PcmAccumulator {
  readonly maxSamples: number
  private buf: Int16Array
  private length = 0
  private carry: number | null = null
  totalBytes = 0
  frames = 0
  droppedSamples = 0
  lastFrameRms = 0

  constructor(maxSeconds = 120) {
    this.maxSamples = Math.floor(maxSeconds * SAMPLE_RATE)
    this.buf = new Int16Array(Math.min(this.maxSamples, SAMPLE_RATE * 4))
  }

  get sampleCount(): number {
    return this.length
  }

  push(bytes: Uint8Array): void {
    this.frames++
    this.totalBytes += bytes.length
    let i = 0
    const frameStart = this.length
    if (this.carry !== null && bytes.length > 0) {
      this.append(this.carry | (bytes[0] << 8))
      this.carry = null
      i = 1
    }
    for (; i + 1 < bytes.length; i += 2) {
      this.append(bytes[i] | (bytes[i + 1] << 8))
    }
    if (i < bytes.length) this.carry = bytes[i]
    this.lastFrameRms = rms(this.buf, frameStart, this.length)
  }

  samples(): Int16Array {
    return this.buf.subarray(0, this.length)
  }

  private append(u16: number): void {
    if (this.length >= this.maxSamples) {
      this.droppedSamples++
      return
    }
    if (this.length >= this.buf.length) {
      const next = new Int16Array(Math.min(this.maxSamples, this.buf.length * 2))
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.length++] = (u16 << 16) >> 16
  }
}

export interface ClipStats {
  bytes: number
  frames: number
  samples: number
  seconds: number
  rmsDb: number
  peakDb: number
  droppedSamples: number
}

export function clipStats(acc: PcmAccumulator): ClipStats {
  const s = acc.samples()
  return {
    bytes: acc.totalBytes,
    frames: acc.frames,
    samples: s.length,
    seconds: bytesToSeconds(acc.totalBytes),
    rmsDb: toDbfs(rms(s)),
    peakDb: toDbfs(peak(s)),
    droppedSamples: acc.droppedSamples,
  }
}
