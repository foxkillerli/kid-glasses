import { describe, expect, it } from 'vitest'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { glyphPages, FULL_GEOMETRY } from '../src/app'
import { capacityPages } from '../src/content/capacity'
import { LIMIT_REBUILD, utf8Bytes } from '../src/lib/limits'

const BODY_INNER_W = 576 - 2 * 4
const BODY_INNER_H = 224 - 2 * 4

describe('glyph pages fit the body container (pretext font model)', () => {
  const pages = glyphPages()
  it('has pages', () => {
    expect(pages.length).toBeGreaterThan(4)
  })
  for (const p of pages) {
    it(`${p.title}: every line fits one visual line and page fits body`, () => {
      for (const line of p.lines) {
        expect(getTextWidth(line), line).toBeLessThanOrEqual(BODY_INNER_W)
      }
      const body = p.lines.join('\n')
      const m = measureTextWrap(body, BODY_INNER_W)
      expect(m.height).toBeLessThanOrEqual(BODY_INNER_H)
      expect(utf8Bytes(body)).toBeLessThanOrEqual(LIMIT_REBUILD)
    })
  }
})

describe('capacity pages stay inside the rebuild limit', () => {
  for (const p of capacityPages(FULL_GEOMETRY)) {
    it(p.title, () => {
      expect(utf8Bytes(p.body)).toBeLessThanOrEqual(LIMIT_REBUILD)
    })
  }
})
