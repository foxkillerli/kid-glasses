import { describe, expect, it } from 'vitest'
import { paginateLines } from '../src/lib/paginate'

describe('paginateLines', () => {
  it('splits by line count', () => {
    const pages = paginateLines(['a', 'b', 'c', 'd', 'e'], { maxLines: 2, maxBytes: 1000 })
    expect(pages).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('splits by UTF-8 bytes including the newline, counting CJK as 3 bytes', () => {
    const pages = paginateLines(['汉字', '汉字', 'x'], { maxLines: 10, maxBytes: 9 })
    expect(pages).toEqual([['汉字'], ['汉字', 'x']])
  })

  it('rejects a single line that can never fit', () => {
    expect(() => paginateLines(['toolong'], { maxLines: 5, maxBytes: 4 })).toThrow(/exceeds maxBytes/)
  })
})
