import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISABLED_FAST_LANE } from '../src/fast-lane'
import { HubCore } from '../src/hub-core'
import { handlePair, handleSlackEvents } from '../src/index'
import { KidWebhookClient } from '../src/kid-webhook'
import { relayLog } from '../src/log'
import { Pairing } from '../src/pairing'
import { KidDmClient } from '../src/slack-client'
import { slackSignature } from '../src/slack-verify'
import type { Env } from '../src/env'
import { FakeDevice, FakeStorage, flush } from './fakes'

const S = {
  slackToken: ['xoxp', 'SENTINELTOKEN', '1111'].join('-'),
  channel: 'DSENTINELCH9',
  webhookUrl: 'https://sentinel-hook.example/run?k=SENTINELQUERY',
  webhookSecret: 'SENTINELWEBHOOKSECRET'.padEnd(64, 'x'),
  deviceToken: 'SENTINELDEVICETOKEN'.padEnd(40, 'y'),
  signing: 'SENTINELSIGNING',
  text: '秘密内容SENTINELTEXT',
  kidText: 'Kid说SENTINELKIDTEXT',
  wrongToken: 'SENTINELWRONGTOKEN'.padEnd(40, 'z'),
  asr: 'SENTINELASRERR',
  ip: '203.0.113.77',
}
const FOX = 'UFOXSENT01'

let lines: string[] = []
beforeEach(() => {
  lines = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' ')))
  }
})
afterEach(() => vi.restoreAllMocks())

function assertClean(extra: string[] = []) {
  const all = lines.join('\n')
  for (const v of [...Object.values(S), ...extra]) expect(all, `log leaked ${v.slice(0, 12)}…`).not.toContain(v)
}

function hub(slackFetch: typeof fetch, webhookFetch: (u: string, i: RequestInit) => Promise<Response>, asrFail = false) {
  const storage = new FakeStorage()
  const device = new FakeDevice()
  const core = new HubCore({
    storage,
    sockets: () => [device],
    deviceToken: S.deviceToken,
    slack: new KidDmClient(S.slackToken, S.channel, slackFetch),
    asr: { connect: async () => { if (asrFail) throw new Error(`connect ${S.asr} ${S.webhookUrl}`); throw new Error('unused') } },
    fastLane: DISABLED_FAST_LANE,
    kidWebhook: new KidWebhookClient(S.webhookUrl, S.webhookSecret, { fetchFn: webhookFetch, sleep: async () => {} }),
    pairing: new Pairing({ storage, now: () => Date.now() }),
    now: () => Date.now(),
    log: m => relayLog(`hub ${m}`),
  })
  return { core, device }
}

const slackOk = (async (url: RequestInfo | URL) => {
  if (String(url).includes('auth.test')) return Response.json({ ok: true, user_id: FOX })
  return Response.json({ ok: true, ts: '1700000000.000100', channel: S.channel })
}) as typeof fetch

describe('logs never contain secrets, ids that identify channels, or message text', () => {
  it('say -> Slack post -> webhook (ok, 5xx, throwing with the URL in the error)', async () => {
    for (const hook of [
      async () => new Response('ok'),
      async () => new Response(`bad ${S.webhookSecret}`, { status: 503 }),
      async (u: string) => { throw new TypeError(`fetch failed ${u}`) },
    ]) {
      const { core } = hub(slackOk, hook)
      await core.onDeviceMessage(new FakeDevice(), JSON.stringify({ t: 'say', text: S.text, cid: 'cid-guard-0001' }))
    }
    expect(lines.some(l => l.includes('kid webhook failed status=503'))).toBe(true)
    assertClean()
  })

  it('Slack post failures (API error and a thrown error carrying the token)', async () => {
    const failing = [
      (async () => Response.json({ ok: false, error: 'not_in_channel' })) as typeof fetch,
      (async () => { throw new TypeError(`network ${S.slackToken} ${S.channel}`) }) as typeof fetch,
      (async () => Response.json({ ok: true, ts: '1', channel: 'DOTHERCHAN1' })) as typeof fetch,
    ]
    for (const f of failing) {
      const { core, device } = hub(f, async () => new Response('ok'))
      await core.sayFromGlasses(S.text)
      for (const e of device.of('error')) {
        expect(JSON.stringify(e)).not.toContain(S.channel)
        expect(JSON.stringify(e)).not.toContain(S.slackToken)
      }
    }
    expect(lines.some(l => l.includes('slack post failed'))).toBe(true)
    assertClean()
  })

  it('device auth with a wrong token, Kid replies, ASR connect failure', async () => {
    const { core } = hub(slackOk, async () => new Response('ok'), true)
    const ws = new FakeDevice(false)
    await core.onDeviceMessage(ws, JSON.stringify({ t: 'auth', token: S.wrongToken }))
    const ok = new FakeDevice(false)
    await core.onDeviceMessage(ok, JSON.stringify({ t: 'auth', token: S.deviceToken }))
    await core.onKidMessage({ eventId: 'E1', channel: S.channel, user: 'UKIDBOT01', botId: 'BKID01', text: S.kidText, ts: '1.1', threadTs: null, kind: 'message', verifiedKid: false })
    await core.onDeviceMessage(ok, JSON.stringify({ t: 'audio.start' }))
    await flush()
    expect(lines.some(l => l.includes('device auth rejected'))).toBe(true)
    expect(lines.some(l => l.includes('asr connect failed'))).toBe(true)
    assertClean()
  })

  it('pairing: codes, pair ids and minted tokens never reach the log', async () => {
    const { core } = hub(slackOk, async () => new Response('ok'))
    const s = (await core.pairRequest('/pair/start', null, 'c'))!.body as { pairId: string; code: string }
    await core.pairRequest('/pair-confirm', { user: 'UNOTFOX01', code: s.code }, 'slack')
    await core.pairRequest('/pair-confirm', { user: FOX, code: s.code === '000000' ? '111111' : '000000' }, 'slack')
    await core.pairRequest('/pair-confirm', { user: FOX, code: s.code }, 'slack')
    const r = (await core.pairRequest('/pair/poll', { pairId: s.pairId }, 'c'))!.body as { token: string }
    const ws = new FakeDevice(false)
    await core.onDeviceMessage(ws, JSON.stringify({ t: 'auth', token: r.token }))
    expect(lines.some(l => l.includes('pair confirm ok'))).toBe(true)
    assertClean([s.code, s.pairId, r.token])
  })

  it('Worker entry: Slack events (kid text, pairing message, bad signature, other channel) and pair endpoints', async () => {
    const fetchStub = vi.fn(async () => Response.json({ pairId: 'a'.repeat(32), code: '123456' }))
    const env = {
      HUB: { idFromName: () => 'id', get: () => ({ fetch: fetchStub }) } as unknown as DurableObjectNamespace,
      SLACK_SIGNING_SECRET: S.signing,
      KID_DM_CHANNEL_ID: S.channel,
      DEVICE_TOKEN: S.deviceToken,
    } as Env
    const send = async (event: Record<string, unknown>, sign = true) => {
      const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', authorizations: [{ user_id: FOX, is_bot: false }], event: { type: 'message', channel_type: 'im', ...event } })
      const ts = '1700000000'
      const sig = sign ? await slackSignature(S.signing, ts, body) : 'v0=bad'
      return handleSlackEvents(new Request('https://r/slack/events', { method: 'POST', headers: { 'X-Slack-Request-Timestamp': ts, 'X-Slack-Signature': sig }, body }), env, 1700000000)
    }
    await send({ channel: S.channel, bot_id: 'BKID01', subtype: 'bot_message', text: S.kidText, ts: '1.2' })
    await send({ channel: S.channel, user: FOX, text: '配对 654321', ts: '1.3' })
    await send({ channel: S.channel, user: FOX, text: S.text, ts: '1.4' })
    await send({ channel: 'DSOMEONEELSE', user: FOX, text: S.text, ts: '1.5' })
    await send({ channel: S.channel, user: FOX, text: S.text, ts: '1.6' }, false)
    const pairReq = (path: string, body: string) => new Request(`https://r${path}`, { method: 'POST', headers: { 'CF-Connecting-IP': S.ip }, body })
    await handlePair(pairReq('/pair/start', ''), env, '/pair/start')
    await handlePair(pairReq('/pair/poll', JSON.stringify({ pairId: 'b'.repeat(32) })), env, '/pair/poll')
    expect(lines.some(l => l.includes('slack event rejected reason=bad-signature'))).toBe(true)
    expect(lines.some(l => l.includes('slack event routed kind=pair-confirm'))).toBe(true)
    assertClean(['654321', 'DSOMEONEELSE'])
  })
})
