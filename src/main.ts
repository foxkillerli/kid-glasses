import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { App, type Mirror } from './app'
import type { Layout } from './lib/display'
import type { KV } from './lib/ringlog'

function pickStorage(): KV | null {
  try {
    const probe = '__kg_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}

const mirrorEl = document.getElementById('mirror')
const extraEl = document.getElementById('extra')

const mirror: Mirror = {
  render(layout: Layout | null, extra: string) {
    if (mirrorEl && layout) {
      mirrorEl.textContent = layout.boxes
        .filter(b => b.name !== 'cap')
        .map(b => `── ${b.name} (${b.w}x${b.h}) ──\n${b.content}`)
        .join('\n')
    }
    if (extraEl) extraEl.textContent = extra
  },
}

const bridge = await waitForEvenAppBridge()
const app = new App(bridge, mirror, pickStorage())
;(window as unknown as { kg: App }).kg = app
await app.start()
console.log('[kg] APP_READY')
