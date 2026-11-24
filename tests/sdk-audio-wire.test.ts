import { describe, expect, it } from 'vitest'

const hostCalls: unknown[][] = []
const g = globalThis as Record<string, unknown>
g.window = globalThis
g.document = g.document ?? { addEventListener() {}, readyState: 'complete' }
g.addEventListener = g.addEventListener ?? (() => {})
g.flutter_inappwebview = {
  callHandler: async (...args: unknown[]) => {
    hostCalls.push(args)
    return true
  },
}

describe('what the SDK 0.0.16 sends to the Even App for our mic calls', () => {
  it('serialises open and close as source "glasses" over the Flutter bridge', async () => {
    const sdk = await import('@evenrealities/even_hub_sdk')
    const { openGlassesMic, closeGlassesMic } = await import('../src/lib/mic-control')
    const bridge = sdk.EvenAppBridge.getInstance()
    await openGlassesMic(bridge)
    await closeGlassesMic(bridge)
    const payloads = hostCalls.map(([handler, json]) => ({ handler, msg: JSON.parse(String(json)) }))
    expect(payloads).toEqual([
      { handler: 'evenAppMessage', msg: { type: 'call_even_app_method', method: 'audioControl', data: { isOpen: true, source: 'glasses' } } },
      { handler: 'evenAppMessage', msg: { type: 'call_even_app_method', method: 'audioControl', data: { isOpen: false, source: 'glasses' } } },
    ])
  })
})
