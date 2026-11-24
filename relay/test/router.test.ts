import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { configStatus } from '../src/env'
import { fastLaneFor } from '../src/fast-lane'
import worker, { handleDevice, handleSlackEvents } from '../src/index'
import { slackSignature } from '../src/slack-verify'

const KID = 'D0123ABCDEF'
const SECRET = 'test-signing-secret'
const DEVICE = 'd'.repeat(40)

function env(over: Partial<Env> = {}) {
  const fetchStub = vi.fn(async (_input: RequestInfo, _init?: RequestInit) => new Response('stub'))
  const e = {
    HUB: { idFromName: vi.fn(() => 'id'), get: vi.fn(() => ({ fetch: fetchStub })) } as unknown as DurableObjectNamespace,
    SLACK_SIGNING_SECRET: SECRET,
    KID_DM_CHANNEL_ID: KID,
    DEVICE_TOKEN: DEVICE,
    ...over,
  } as Env
  return { e, fetchStub }
}

async function slackRequest(payload: unknown, ts = 1_700_000_000) {
  const body = JSON.stringify(payload)
  return new Request('https://relay.test/slack/events', {
    method: 'POST',
    headers: { 'X-Slack-Request-Timestamp': String(ts), 'X-Slack-Signature': await slackSignature(SECRET, String(ts), body) },
    body,
  })
}

describe('POST /slack/events', () => {
  it('answers url_verification after checking the signature', async () => {
    const { e } = env()
    const res = await handleSlackEvents(await slackRequest({ type: 'url_verification', challenge: 'c-123' }), e, { waitUntil: vi.fn() }, 1_700_000_000)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('c-123')
  })

  it('rejects unsigned or stale requests and fails closed without a secret', async () => {
    const { e } = env()
    const unsigned = new Request('https://relay.test/slack/events', { method: 'POST', body: '{}' })
    expect((await handleSlackEvents(unsigned, e, { waitUntil: vi.fn() }, 1_700_000_000)).status).toBe(401)
    expect((await handleSlackEvents(await slackRequest({}, 1_700_000_000), e, { waitUntil: vi.fn() }, 1_700_000_000 + 600)).status).toBe(401)
    const { e: noSecret } = env({ SLACK_SIGNING_SECRET: undefined })
    expect((await handleSlackEvents(await slackRequest({}), noSecret, { waitUntil: vi.fn() }, 1_700_000_000)).status).toBe(503)
  })

  it('forwards a Kid DM message to the hub in the background and acks at once', async () => {
    const { e, fetchStub } = env()
    const waitUntil = vi.fn()
    const payload = { type: 'event_callback', event_id: 'Ev9', event: { type: 'message', channel: KID, channel_type: 'im', user: 'UKID', text: 'hi', ts: '1.1' } }
    const res = await handleSlackEvents(await slackRequest(payload), e, { waitUntil }, 1_700_000_000)
    expect(await res.text()).toBe('ok')
    expect(waitUntil).toHaveBeenCalledOnce()
    const [url, init] = fetchStub.mock.calls[0]
    expect(url).toBe('https://hub/kid-message')
    expect(JSON.parse(init?.body as string)).toMatchObject({ eventId: 'Ev9', text: 'hi' })
  })

  it('acks but does not forward messages from other channels', async () => {
    const { e, fetchStub } = env()
    const payload = { type: 'event_callback', event: { type: 'message', channel: 'D9999999999', user: 'U', text: 'x', ts: '1' } }
    const res = await handleSlackEvents(await slackRequest(payload), e, { waitUntil: vi.fn() }, 1_700_000_000)
    expect(await res.text()).toBe('ignored: other-channel')
    expect(fetchStub).not.toHaveBeenCalled()
  })
})

describe('/device', () => {
  it('requires a WebSocket upgrade and a valid device token', async () => {
    const { e, fetchStub } = env()
    expect((await handleDevice(new Request('https://relay.test/device'), e)).status).toBe(426)
    const bad = new Request('https://relay.test/device', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'kg.v1, kg-token.wrong' } })
    expect((await handleDevice(bad, e)).status).toBe(401)
    expect(fetchStub).not.toHaveBeenCalled()
  })

  it('hands an authenticated upgrade to the hub with the chosen subprotocol', async () => {
    const { e, fetchStub } = env()
    const ok = new Request('https://relay.test/device', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `kg.v1, kg-token.${DEVICE}`, 'X-KG-Protocol': 'spoofed' } })
    await handleDevice(ok, e)
    const forwarded = fetchStub.mock.calls[0][0] as Request
    expect(forwarded.headers.get('X-KG-Protocol')).toBe('kg.v1')
  })
})

describe('config', () => {
  it('reports which secrets are set without exposing values, with the fast lane off by default', async () => {
    const { e } = env()
    const res = await worker.fetch(new Request('https://relay.test/health'), e, { waitUntil: vi.fn() } as unknown as ExecutionContext)
    const json = (await res.json()) as { config: Record<string, boolean> }
    expect(json.config).toEqual(configStatus(e))
    expect(JSON.stringify(json)).not.toContain(SECRET)
    expect(json.config.fastLane).toBe(false)
    expect(fastLaneFor({ ...e, FAST_LANE_ENABLED: 'true' }).enabled).toBe(false)
    expect(fastLaneFor({ ...e, FAST_LANE_ENABLED: 'true', FAST_LLM_KEY: 'k' }).enabled).toBe(true)
  })
})
