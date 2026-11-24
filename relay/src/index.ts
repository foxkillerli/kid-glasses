import { deviceTokenConfigured, offeredDeviceProtocol } from './device-auth'
import { configStatus, type Env } from './env'
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
  if (!verdict.ok) return new Response(verdict.reason, { status: verdict.reason === 'no-secret' ? 503 : 401 })
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return new Response('bad json', { status: 400 })
  }
  const route = routeSlackEvent(parsed, env.KID_DM_CHANNEL_ID)
  if (route.kind === 'challenge') return new Response(route.challenge, { headers: { 'Content-Type': 'text/plain' } })
  if (route.kind === 'ignore') return new Response(`ignored: ${route.reason}`)
  try {
    const res = await hubStub(env).fetch('https://hub/kid-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route.message),
    })
    if (!res.ok) return new Response('hub error', { status: 500 })
  } catch {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ ok: true, config: configStatus(env) })
    if (url.pathname === '/device') return handleDevice(request, env)
    if (url.pathname === '/slack/events' && request.method === 'POST') return handleSlackEvents(request, env, Math.floor(Date.now() / 1000))
    return new Response('not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>
