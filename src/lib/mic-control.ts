import { AudioInputSource } from '@evenrealities/even_hub_sdk'

export const MIC_SOURCE = AudioInputSource.Glasses

export interface MicBridge {
  audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>
}

export function openGlassesMic(bridge: MicBridge): Promise<boolean> {
  return bridge.audioControl(true, MIC_SOURCE)
}

export function closeGlassesMic(bridge: MicBridge): Promise<boolean> {
  return bridge.audioControl(false, MIC_SOURCE)
}

const HOST_SOURCE_KEYS = ['source', 'audioSource', 'audio_source', 'inputSource', 'input_source']

export type FrameVerdict =
  | { accept: true; hostLabel: 'glasses' | 'absent' }
  | { accept: false; reason: string }

export function checkFrameSource(normalizedSource: unknown, raw: unknown): FrameVerdict {
  if (normalizedSource !== MIC_SOURCE) return { accept: false, reason: `sdk-source:${String(normalizedSource)}` }
  let labelled = false
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    for (const k of HOST_SOURCE_KEYS) {
      if (!(k in r)) continue
      if (r[k] !== MIC_SOURCE) return { accept: false, reason: `host-${k}:${String(r[k])}` }
      labelled = true
    }
  }
  return { accept: true, hostLabel: labelled ? 'glasses' : 'absent' }
}
