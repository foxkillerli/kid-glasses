import { describe, expect, it } from 'vitest'
import { GLASSES_PREFIX, MAX_INCOMING_CHARS, cleanText, fromSlack, isFromGlasses, toSlack } from '../src/sanitize'

describe('toSlack (glasses -> Slack)', () => {
  it('prefixes 〔眼镜〕 and escapes Slack control characters so no mention can be formed', () => {
    expect(toSlack('今天几点放学？')).toBe('〔眼镜〕今天几点放学？')
    expect(toSlack('<!channel> a&b <@U123>')).toBe('〔眼镜〕&lt;!channel&gt; a&amp;b &lt;@U123&gt;')
  })

  it('strips control and invisible characters, collapses whitespace, and rejects empty text', () => {
    expect(toSlack('  hi\u0000​   there \r\n\n\n\nok ')).toBe('〔眼镜〕hi there\n\nok')
    expect(toSlack(' ​\t ')).toBeNull()
  })

  it('caps very long transcripts', () => {
    const out = toSlack('字'.repeat(5000)) as string
    expect(Array.from(out).length).toBe(GLASSES_PREFIX.length + 1500)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('fromSlack (Slack -> lens)', () => {
  it('turns Slack markup into plain lens text', () => {
    expect(fromSlack('Hi <@U123|fox>, see <https://example.com|the link> or <https://x.y/z>')).toBe('Hi @fox, see the link or https://x.y/z')
    expect(fromSlack('<@U123ABC> <!here> <#C123|general>')).toBe('@用户 @here #general')
    expect(fromSlack('*粗体* and _italic_ and ~gone~ and `code`')).toBe('粗体 and italic and gone and code')
    expect(fromSlack('snake_case_name stays')).toBe('snake_case_name stays')
    expect(fromSlack('a &lt;b&gt; &amp; c')).toBe('a <b> & c')
    expect(fromSlack('&gt; quoted\nreply')).toBe('quoted\nreply')
    expect(fromSlack('好的 :thumbsup: 明天见 :smile:')).toBe('好的 明天见')
    expect(fromSlack('12:30:45 放学，9:00:00 到校')).toBe('12:30:45 放学，9:00:00 到校')
    expect(fromSlack('赞 :+1: 时间 a:b:c')).toBe('赞 时间 a:b:c')
  })

  it('removes control characters and caps length', () => {
    expect(fromSlack('a\u0007b‮c')).toBe('abc')
    expect(Array.from(fromSlack('x'.repeat(5000))).length).toBe(MAX_INCOMING_CHARS)
  })

  it('recognises messages that came from the glasses', () => {
    expect(isFromGlasses('〔眼镜〕hi')).toBe(true)
    expect(isFromGlasses('hi 〔眼镜〕')).toBe(false)
    expect(isFromGlasses(undefined)).toBe(false)
    expect(cleanText(' a \n b ')).toBe('a\nb')
  })
})
