export type Gesture =
  | 'click'
  | 'double'
  | 'up'
  | 'down'
  | 'longStart'
  | 'longEnd'
  | 'fgEnter'
  | 'fgExit'
  | 'abnormalExit'
  | 'systemExit'
  | 'imu'

const TYPE_TO_GESTURE: Record<number, Gesture> = {
  0: 'click',
  1: 'up',
  2: 'down',
  3: 'double',
  4: 'fgEnter',
  5: 'fgExit',
  6: 'abnormalExit',
  7: 'systemExit',
  8: 'imu',
  9: 'longStart',
  10: 'longEnd',
}

interface Envelope {
  eventType?: number | null
}

export interface EventLike {
  sysEvent?: Envelope | null
  textEvent?: Envelope | null
  listEvent?: Envelope | null
  audioEvent?: unknown
  menuItemClickEvent?: unknown
}

export function eventTypeOf(envelope?: Envelope | null): number | null {
  if (!envelope) return null
  const t = envelope.eventType
  return t === undefined || t === null ? 0 : t
}

export interface Classified {
  gesture: Gesture
  via: 'sys' | 'text' | 'list'
  rawType: number
}

export function classify(event: EventLike): Classified | null {
  const candidates: Array<['sys' | 'text' | 'list', Envelope | null | undefined]> = [
    ['sys', event.sysEvent],
    ['text', event.textEvent],
    ['list', event.listEvent],
  ]
  for (const [via, env] of candidates) {
    const t = eventTypeOf(env)
    if (t === null) continue
    const gesture = TYPE_TO_GESTURE[t]
    if (gesture) return { gesture, via, rawType: t }
  }
  return null
}
