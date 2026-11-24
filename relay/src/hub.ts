import { buildListenUrl, connectDeepgram } from './deepgram'
import { AUTH_TIMEOUT_MS, type SocketAttachment } from './device-auth'
import type { Env } from './env'
import { fastLaneFor } from './fast-lane'
import { CLOSE_UNAUTHORIZED, HubCore, isAuthed, type AsrSocket } from './hub-core'
import type { KidMessage } from './slack-events'
import { KidDmClient } from './slack-client'

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

export class RelayHub implements DurableObject {
  private readonly core: HubCore

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    const key = env.DEEPGRAM_API_KEY
    this.core = new HubCore({
      storage: state.storage,
      sockets: () => state.getWebSockets(),
      deviceToken: env.DEVICE_TOKEN,
      slack: new KidDmClient(env.SLACK_USER_TOKEN, env.KID_DM_CHANNEL_ID),
      asr: key ? { connect: async () => asAsrSocket(await connectDeepgram(buildListenUrl({ model: env.DEEPGRAM_MODEL, language: env.DEEPGRAM_LANGUAGE }), key)) } : null,
      fastLane: fastLaneFor(env),
      now: () => Date.now(),
      log: m => console.log(`[hub] ${m}`),
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
    if (url.pathname === '/kid-message' && request.method === 'POST') {
      const item = await this.core.onKidMessage((await request.json()) as KidMessage)
      return Response.json({ delivered: !!item })
    }
    return new Response('not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    let pending = false
    for (const ws of this.state.getWebSockets()) {
      if (isAuthed(ws)) continue
      const a = ws.deserializeAttachment() as SocketAttachment | null
      if (!a || now - a.connectedAt >= AUTH_TIMEOUT_MS) closeReply(ws, CLOSE_UNAUTHORIZED, 'auth timeout')
      else pending = true
    }
    if (pending) await this.state.storage.setAlarm(now + AUTH_TIMEOUT_MS)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.onDeviceMessage(ws, message)
  }

  private stopAsrIfNoDevices(closing: WebSocket): void {
    const open = this.state.getWebSockets().filter(w => w !== closing && w.readyState === OPEN && isAuthed(w))
    if (open.length === 0) this.core.stopAsr('no-devices')
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closeReply(ws, code, reason)
    this.stopAsrIfNoDevices(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.stopAsrIfNoDevices(ws)
  }
}
