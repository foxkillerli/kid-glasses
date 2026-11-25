const envOrigin = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_RELAY_ORIGIN?.trim()
const origin = (envOrigin || 'https://kid-glasses-relay.your-subdomain.workers.dev').replace(/\/+$/, '')

export const RELAY_ORIGIN = origin
export const RELAY_WS_URL = origin.replace(/^http/, 'ws') + '/device'
export const RELAY_PROTOCOL = 'kg.v1'

export const RELAY_TIMING = {
  pingMs: 25_000,
  idleMs: 70_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  outboxTtlMs: 12 * 60 * 60 * 1000,
  outboxMax: 20,
  maxSendTries: 4,
  pairPollMs: 2_500,
  connectTimeoutMs: 10_000,
  probeMs: 5_000,
  retryBaseMs: 10_000,
  httpTimeoutMs: 10_000,
} as const

export const STORE_KEYS = {
  token: 'kg.relay.token',
  lastSeq: 'kg.relay.lastSeq',
  outbox: 'kg.relay.outbox',
  pairing: 'kg.relay.pairing',
  asrLang: 'kg.asr.lang',
} as const
