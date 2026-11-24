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
