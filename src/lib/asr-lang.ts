export type AsrLang = 'auto' | 'zh' | 'en'

export const ASR_LANGS: readonly AsrLang[] = ['auto', 'zh', 'en']

export const ASR_LANG_LABEL: Record<AsrLang, string> = {
  auto: '自动（中英）',
  zh: '中文',
  en: 'English',
}

export const ASR_LANG_SHORT: Record<AsrLang, string> = {
  auto: '',
  zh: '中文',
  en: 'EN',
}

export function parseAsrLang(raw: string | null | undefined): AsrLang {
  return ASR_LANGS.includes(raw as AsrLang) ? (raw as AsrLang) : 'auto'
}

export function nextAsrLang(l: AsrLang): AsrLang {
  return ASR_LANGS[(ASR_LANGS.indexOf(l) + 1) % ASR_LANGS.length]
}
