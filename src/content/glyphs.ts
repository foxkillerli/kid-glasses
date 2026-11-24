import { chunk, pad } from '../lib/paginate'

const COMMON_RAW =
  '的一是了我不在人有这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式李息写呢识极令黄德收脸钱党倒未持取设始版双历越史商千片容研像找友孩站广改议形委早房音火际则首单据导影失拿网香似斯专石若兵弟谁校读志飞观争究包组造落视济喜离虽坏兴妈爸奶爷姐哥妹弟宝贝玩饭睡觉讲故事唱歌画画'

export function dedupeChars(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ch of Array.from(s)) {
    if (seen.has(ch)) continue
    seen.add(ch)
    out.push(ch)
  }
  return out
}

export const COMMON_HANZI = dedupeChars(COMMON_RAW)

export function hanziLines(chars: string[], perLine = 20, group = 10): string[] {
  return chunk(chars, perLine).map((row, i) => {
    const start = i * perLine + 1
    const groups = chunk(row, group).map(g => g.join(''))
    return `${pad(start, 3)} ${groups.join(' ')}`
  })
}

export interface Sample {
  id: string
  text: string
  note?: string
}

function labelled(prefix: string, items: string[]): Sample[] {
  return items.map((text, i) => ({ id: `${prefix}${pad(i + 1, 2)}`, text }))
}

export const PUNCT_SAMPLES: Sample[] = labelled('P', [
  '，', '。', '！', '？', '：', '；', '“', '”', '‘', '’', '（', '）', '【', '】', '《', '》', '、', '…', '—', '·',
  '「', '」', '～', '〈', '〉', '『', '』', '——', '……', '¥',
])

export const WIDTH_SAMPLES: Sample[] = labelled('W', [
  'Ａ/A', 'ｚ/z', '０/0', '９/9', '！/!', '？/?', '，/,', '．/.', '：/:', '；/;', '（/(', '）/)',
  '［/[', '］/]', '｛/{', '｝/}', '＂/"', '＇/\'', '～/~', '＠/@', '＃/#', '％/%', '＆/&', '＋/+',
  '－/-', '＝/=', '／//', '＼/\\', '＜/<', '＞/>', '　/ ',
])

export const MIXED_SAMPLES: Sample[] = labelled('M', [
  '今天3点去Park玩，OK吗？',
  'iPhone 17 Pro电量85%',
  '妈妈说：“Time to eat!”',
  'Room 302房间，2026年11月24日',
  '我想听Peppa Pig的故事。',
  'A1 B2 C3 一二三 123',
  'Wi-Fi密码是abc123',
  '温度-5°C～12°C',
])

export const RARE_SAMPLES: Sample[] = labelled('R', [
  '龘', '靐', '齉', '貔', '貅', '饕', '餮', '犇', '骉', '鱻', '麤', '燚', '淼', '焱', '垚', '鑫',
  '體', '龜', '鬱', '灣', '曬', '囧', '槑', '𠀀', '𪚥', '〇', '㐀', '々', '😀', '★', '●', '▲',
])

export function sampleLines(samples: Sample[], perLine: number): string[] {
  return chunk(samples, perLine).map(row => row.map(s => `${s.id}[${s.text}]`).join(' '))
}

export function mixedLines(samples: Sample[]): string[] {
  return samples.map(s => `${s.id} ${s.text}`)
}
