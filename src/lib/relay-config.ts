export const RELAY_ORIGIN = 'https://kid-glasses-relay.your-subdomain.workers.dev'
export const RELAY_WS_URL = 'wss://kid-glasses-relay.your-subdomain.workers.dev/device'
export const RELAY_PROTOCOL = 'kg.v1'

export const RELAY_TIMING = {
  pingMs: 25_000,
  idleMs: 70_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  outboxTtlMs: 12 * 60 * 60 * 1000,
  outboxMax: 20,
  maxSendTries: 3,
  pairPollMs: 2_500,
} as const

export const STORE_KEYS = {
  token: 'kg.relay.token',
  lastSeq: 'kg.relay.lastSeq',
  outbox: 'kg.relay.outbox',
  pairing: 'kg.relay.pairing',
} as const
