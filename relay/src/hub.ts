import { buildListenUrl, connectDeepgram, listenOptionsFor } from './deepgram'
import { AUTH_TIMEOUT_MS, type SocketAttachment } from './device-auth'
import type { Env } from './env'
import { fastLaneFor } from './fast-lane'
import { CLOSE_UNAUTHORIZED, HubCore, isAuthed, type AsrSocket } from './hub-core'
import type { KidMessage } from './slack-events'
import { KidDmClient } from './slack-client'
import { KidWebhookClient, kidWebhookConfigured } from './kid-webhook'
import { errorName, relayLog } from './log'
import { Pairing } from './pairing'

export const PROTOCOL_HEADER = 'X-KG-Protocol'
const OPEN = 1

function asAsrSocket(ws: WebSocket): AsrSocket {
  return {
    send: data => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    addEventListener: (type, listener) => ws.addEventListener(type, ev => listener(ev as unknown as { data?: unknown; code?: number })),
  }
}

export function closeReply(ws: Pick<WebSocket, 'close'>, code: number, reason: string): void {
  try {
    if (code === 1005 || code === 1006 || code === 1015 || code < 1000) ws.close()
    else ws.close(code, reason)
  } catch {
    return
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await request.text())
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export class RelayHub implements DurableObject {
  private readonly core: HubCore
  private readonly pairing: Pairing
  private readonly slack: KidDmClient

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    const key = env.DEEPGRAM_API_KEY
    const storage = {
      get: <T>(key: string) => state.storage.get<T>(key),
      put: <T>(key: string, value: T) => state.storage.put(key, value),
      putAll: (entries: Record<string, unknown>) => state.storage.put(entries),
      delete: (key: string) => state.storage.delete(key),
      list: <T>(options: DurableObjectListOptions) => state.storage.list<T>(options),
    }
    this.pairing = new Pairing({ storage, now: () => Date.now() })
    this.slack = new KidDmClient(env.SLACK_USER_TOKEN, env.KID_DM_CHANNEL_ID)
    this.core = new HubCore({
      storage,
      sockets: () => state.getWebSockets(),
      deviceToken: env.DEVICE_TOKEN,
      slack: this.slack,
      pairing: this.pairing,
      asr: key
        ? {
            connect: async (lang, fallback, signal) =>
              asAsrSocket(await connectDeepgram(buildListenUrl(listenOptionsFor(lang, { model: env.DEEPGRAM_MODEL, language: env.DEEPGRAM_LANGUAGE, hints: env.DEEPGRAM_LANGUAGE_HINTS }, fallback)), key, signal)),
          }
        : null,
      fastLane: fastLaneFor(env),
      kidWebhook: kidWebhookConfigured(env.KID_WEBHOOK_URL, env.KID_WEBHOOK_SECRET) ? new KidWebhookClient(env.KID_WEBHOOK_URL as string, env.KID_WEBHOOK_SECRET as string) : null,
      now: () => Date.now(),
      log: m => relayLog(`hub ${m}`),
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/device') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.state.acceptWebSocket(server)
      const attachment: SocketAttachment = { authed: false, connectedAt: Date.now() }
      server.serializeAttachment(attachment)
      const due = Date.now() + AUTH_TIMEOUT_MS + 500
      const current = await this.state.storage.getAlarm()
      if (current === null || current > due) await this.state.storage.setAlarm(due)
      const protocol = request.headers.get(PROTOCOL_HEADER)
      return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} })
    }
    if (request.method !== 'POST') return new Response('not found', { status: 404 })
    if (url.pathname === '/kid-message') {
      const msg = await readJson(request)
      if (!msg) return new Response('bad json', { status: 400 })
      const item = await this.core.onKidMessage(msg as unknown as KidMessage)
      return Response.json({ delivered: !!item })
    }
    const client = request.headers.get('X-KG-Client') ?? 'unknown'
    const body = await readJson(request)
    const r = await this.core.pairRequest(url.pathname, body, client)
    if (r) return Response.json(r.body, { status: r.status })
    return new Response('not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let pending = false
    for (const ws of this.state.getWebSockets()) {
      try {
        if (isAuthed(ws)) continue
        const a = ws.deserializeAttachment() as SocketAttachment | null
        if (!a || now - a.connectedAt >= AUTH_TIMEOUT_MS) closeReply(ws, CLOSE_UNAUTHORIZED, 'auth timeout')
        else pending = true
      } catch (err) {
        relayLog(`alarm socket skipped ${errorName(err)}`)
      }
    }
    if (pending) await this.state.storage.setAlarm(now + 1000)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.onDeviceMessage(ws, message)
  }

  private stopAsrIfNoDevices(closing: WebSocket): void {
    const open = this.state.getWebSockets().filter(w => w !== closing && w.readyState === OPEN && isAuthed(w))
    if (open.length === 0) this.core.cancelAsr('no-devices')
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeReply(ws, code, reason)
    this.core.onDeviceGone(ws)
    this.stopAsrIfNoDevices(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.core.onDeviceGone(ws)
    this.stopAsrIfNoDevices(ws)
  }
}
