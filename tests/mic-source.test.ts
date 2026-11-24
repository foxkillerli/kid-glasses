import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MIC_SOURCE, closeGlassesMic, openGlassesMic, type MicBridge } from '../src/lib/mic-control'

function files(dir: string, ext: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) ? [p] : []
  })
}

const SRC = files('src', /\.ts$/)
const BROWSER_MIC = /getUserMedia|mediaDevices|AudioContext|MediaRecorder|navigator\./

describe('glasses mic is the only source (runtime)', () => {
  it('opens and closes the mic only with AudioInputSource.Glasses', async () => {
    const bridge: MicBridge = { audioControl: vi.fn(async () => true) }
    await openGlassesMic(bridge)
    await closeGlassesMic(bridge)
    await openGlassesMic(bridge)
    const calls = vi.mocked(bridge.audioControl).mock.calls
    expect(calls).toEqual([
      [true, 'glasses'],
      [false, 'glasses'],
      [true, 'glasses'],
    ])
    expect(MIC_SOURCE).toBe('glasses')
  })
})

describe('glasses mic is the only source (static scan)', () => {
  it('scans a non-empty source tree', () => {
    expect(SRC.length).toBeGreaterThan(5)
  })

  it('calls bridge.audioControl only inside src/lib/mic-control.ts, always with MIC_SOURCE', () => {
    for (const f of SRC) {
      const text = readFileSync(f, 'utf8')
      const calls = text.match(/\.audioControl\(([^)]*)\)/g) ?? []
      if (f.endsWith(join('lib', 'mic-control.ts'))) {
        expect(calls).toEqual(['.audioControl(true, MIC_SOURCE)', '.audioControl(false, MIC_SOURCE)'])
      } else {
        expect(calls, f).toEqual([])
      }
    }
  })

  it('never names the phone source and uses AudioInputSource only in mic-control', () => {
    for (const f of SRC) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/AudioInputSource\.Phone|['"]phone-microphone['"]/)
      if (!f.endsWith(join('lib', 'mic-control.ts'))) expect(text, f).not.toMatch(/AudioInputSource/)
    }
    expect(readFileSync(join('src', 'lib', 'mic-control.ts'), 'utf8')).toMatch(/MIC_SOURCE = AudioInputSource\.Glasses/)
  })

  it('has no browser microphone API in plugin source, index.html or the relay', () => {
    for (const f of [...SRC, 'index.html', ...files(join('relay', 'src'), /\.ts$/)]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(BROWSER_MIC)
    }
  })

  it('has no browser microphone API in the built bundle, when present', () => {
    const built = files(join('dist', 'assets'), /\.js$/)
    for (const f of built) expect(readFileSync(f, 'utf8'), f).not.toMatch(BROWSER_MIC)
  })

  it('declares only the glasses microphone permission', () => {
    const app = JSON.parse(readFileSync('app.json', 'utf8')) as { permissions: Array<{ name: string }> }
    const names = app.permissions.map(p => p.name)
    expect(names).toContain('g2-microphone')
    expect(names).not.toContain('phone-microphone')
  })
})
