export const GLASSES_PREFIX = '〔眼镜〕'
export const MAX_OUTGOING_CHARS = 1500
export const MAX_INCOMING_CHARS = 2000

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/g

export function clip(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s
}

export function cleanText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function toSlack(transcript: string): string | null {
  const body = cleanText(transcript)
  if (!body) return null
  return GLASSES_PREFIX + escapeSlack(clip(body, MAX_OUTGOING_CHARS))
}

export function isFromGlasses(slackText: string | undefined): boolean {
  return !!slackText && slackText.startsWith(GLASSES_PREFIX)
}

export function fromSlack(slackText: string): string {
  let s = slackText
  s = s.replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, '@$2')
  s = s.replace(/<@([UW][A-Z0-9]+)>/g, '@用户')
  s = s.replace(/<#([C][A-Z0-9]+)\|([^>]*)>/g, (_m, _id, name) => (name ? `#${name}` : '#频道'))
  s = s.replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
  s = s.replace(/<!subteam\^[A-Z0-9]+(\|([^>]+))?>/g, (_m, _g, name) => (name ? name : '@群组'))
  s = s.replace(/<!date\^[^|>]+\|([^>]+)>/g, '$1')
  s = s.replace(/<(https?:\/\/|mailto:)[^|>]+\|([^>]+)>/g, '$2')
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
  s = s.replace(/```([\s\S]*?)```/g, '$1')
  s = s.replace(/`([^`\n]+)`/g, '$1')
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s.,!?;:)）。，！？；：])/g, '$1$2')
  s = s.replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s.,!?;:)）。，！？；：])/g, '$1$2')
  s = s.replace(/(^|[\s(（])~([^~\n]+)~(?=$|[\s.,!?;:)）。，！？；：])/g, '$1$2')
  s = s.replace(/^&gt; ?/gm, '')
  s = s.replace(/(^|[^\w:]):(?=[a-z0-9_+-]*[a-z+])[a-z0-9_+-]+:(?=$|[^\w:])/g, '$1')
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return clip(cleanText(s), MAX_INCOMING_CHARS)
}
