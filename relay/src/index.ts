import { deviceTokenConfigured, offeredDeviceProtocol } from './device-auth'
import { configStatus, type Env } from './env'
import { relayLog } from './log'
import { sha256Hex } from './pairing'
import { PROTOCOL_HEADER } from './hub'
import { routeSlackEvent } from './slack-events'
import { verifySlackRequest } from './slack-verify'

export { RelayHub } from './hub'

export const HUB_NAME = 'kid'

function hubStub(env: Env): DurableObjectStub {
  return env.HUB.get(env.HUB.idFromName(HUB_NAME))
}

export async function handleSlackEvents(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  const body = await request.text()
  const verdict = await verifySlackRequest({
    secret: env.SLACK_SIGNING_SECRET,
    timestamp: request.headers.get('X-Slack-Request-Timestamp'),
    signature: request.headers.get('X-Slack-Signature'),
    body,
    nowSeconds,
  })
  if (!verdict.ok) {
    relayLog(`slack event rejected reason=${verdict.reason}`)
    return new Response(verdict.reason, { status: verdict.reason === 'no-secret' ? 503 : 401 })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return new Response('bad json', { status: 400 })
  }
  const route = routeSlackEvent(parsed, env.KID_DM_CHANNEL_ID, { botId: env.KID_BOT_ID || undefined, userId: env.KID_BOT_USER_ID || undefined })
  if (route.kind === 'challenge') return new Response(route.challenge, { headers: { 'Content-Type': 'text/plain' } })
  if (route.kind === 'ignore') {
    if (route.reason !== 'other-channel') relayLog(`slack event ignored reason=${route.reason}`)
    return new Response(`ignored: ${route.reason}`)
  }
  const [path, payload] =
    route.kind === 'kid-message'
      ? ['/kid-message', route.message]
      : route.kind === 'pair-confirm'
        ? ['/pair-confirm', { code: route.code, user: route.user, eventId: route.eventId, atMs: route.atMs }]
        : ['/pair-revoke', { user: route.user, eventId: route.eventId, atMs: route.atMs }]
  relayLog(`slack event routed kind=${route.kind}`)
  try {
    const res = await hubStub(env).fetch(`https://hub${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      relayLog(`slack event hub status=${res.status}`)
      return new Response('hub error', { status: 500 })
    }
  } catch {
    relayLog('slack event hub unavailable')
    return new Response('hub unavailable', { status: 500 })
  }
  return new Response('ok')
}

export async function handleDevice(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket upgrade required', { status: 426 })
  if (!deviceTokenConfigured(env.DEVICE_TOKEN)) return new Response('device-token-not-configured', { status: 503 })
  const protocol = offeredDeviceProtocol(request.headers)
  const headers = new Headers(request.headers)
  headers.delete(PROTOCOL_HEADER)
  if (protocol) headers.set(PROTOCOL_HEADER, protocol)
  return hubStub(env).fetch(new Request(request, { headers }))
}

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
}

export async function handlePair(request: Request, env: Env, path: '/pair/start' | '/pair/poll'): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS_HEADERS })
  const body = path === '/pair/poll' ? (await request.text()).slice(0, 512) : ''
  const client = (await sha256Hex(request.headers.get('CF-Connecting-IP') ?? 'unknown')).slice(0, 16)
  let res: Response
  try {
    res = await hubStub(env).fetch(`https://hub${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KG-Client': client }, body: body || '{}' })
  } catch {
    relayLog(`${path} hub unavailable`)
    return Response.json({ error: 'unavailable' }, { status: 503, headers: CORS_HEADERS })
  }
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v)
  return out
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true, config: configStatus(env) })
    if (url.pathname === '/device') return handleDevice(request, env)
    if (url.pathname === '/slack/events' && request.method === 'POST') return handleSlackEvents(request, env, Math.floor(Date.now() / 1000))
    if (url.pathname === '/pair/start' || url.pathname === '/pair/poll') return handlePair(request, env, url.pathname)
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
