import { pad } from '../lib/paginate'

const CJK_DIGITS = '一二三四五六七八九'
const CJK_TENS = ['十', '廿', '卅', '卌', '圩']

export function cjkRuler(length: number): string {
  let s = ''
  for (let i = 1; i <= length; i++) {
    s += i % 10 === 0 ? CJK_TENS[(i / 10 - 1) % CJK_TENS.length] : CJK_DIGITS[(i % 10) - 1]
  }
  return s
}

export function latinRuler(length: number, filler = 'abcdefghi'): string {
  let s = ''
  for (let i = 1; i <= length; i++) {
    s += i % 10 === 0 ? String((i / 10) % 10) : filler[(i % 10) - 1]
  }
  return s
}

export function numberedLines(prefix: string, count: number, suffix = ''): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${pad(i + 1, 2)}${suffix}`)
}

export interface CapacityPage {
  title: string
  fullscreen: boolean
  body: string
  howToRead: string
}

const EN_SENTENCE =
  'The quick brown fox jumps over the lazy dog while the kids count to ten and laugh about it.'
const ZH_SENTENCE = '今天天气很好，我们去公园玩滑梯和秋千，然后回家吃饭、洗澡、讲故事，最后上床睡觉。'
const MIX_SENTENCE = '下午3点Fox要去school接Kid，记得带water bottle和iPad充电器，路上买2个apple。'

export function capacityPages(geometry: string): CapacityPage[] {
  return [
    {
      title: 'Cap ZH',
      fullscreen: true,
      body: [`[ZH ${geometry}] 第1行末字=每行汉字数 十=10 廿=20 卅=30`, cjkRuler(40), cjkRuler(40), ZH_SENTENCE].join('\n'),
      howToRead: 'Line 2 (first ruler): read its LAST char. 七=7, 十=10, 廿三=23, 卅=30, 卌=40.',
    },
    {
      title: 'Cap EN',
      fullscreen: true,
      body: [`[EN ${geometry}] last char of ruler line 1`, latinRuler(90), latinRuler(90, 'xxxxxxxxx'), EN_SENTENCE].join('\n'),
      howToRead:
        'Ruler lines: digit at every 10th position (1=10, 2=20 ...). Last char "c" after "4" = 43 chars. Report both rulers (abc and xxx) and the last word of the sentence first line.',
    },
    {
      title: 'Cap MIX',
      fullscreen: true,
      body: [`[MIX ${geometry}]`, MIX_SENTENCE, MIX_SENTENCE, cjkRuler(10) + latinRuler(10) + cjkRuler(10) + latinRuler(10)].join('\n'),
      howToRead: 'Report the last word/char on the first visual line of each paragraph.',
    },
    {
      title: 'Lines full',
      fullscreen: true,
      body: numberedLines('L', 14, ` ${geometry}`).join('\n'),
      howToRead: 'Full-screen container: the LAST fully visible line number Lnn = lines per page.',
    },
    {
      title: 'Lines body',
      fullscreen: false,
      body: numberedLines('B', 12, ' 正文行').join('\n'),
      howToRead: 'Normal body (between status and hint): last fully visible Bnn = body lines.',
    },
  ]
}
