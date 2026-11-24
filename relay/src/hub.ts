import { buildListenUrl, connectDeepgram } from './deepgram'
import type { Env } from './env'
import { fastLaneFor } from './fast-lane'
import { HubCore, type AsrSocket } from './hub-core'
import type { KidMessage } from './slack-events'
import { KidDmClient } from './slack-client'

export const PROTOCOL_HEADER = 'X-KG-Protocol'

function asAsrSocket(ws: WebSocket): AsrSocket {
  return {
    send: data => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    addEventListener: (type, listener) => ws.addEventListener(type, ev => listener(ev as unknown as { data?: unknown })),
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
      const protocol = request.headers.get(PROTOCOL_HEADER)
      return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : {} })
    }
    if (url.pathname === '/kid-message' && request.method === 'POST') {
      const item = await this.core.onKidMessage((await request.json()) as KidMessage)
      return Response.json({ delivered: !!item })
    }
    return new Response('not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.core.onDeviceMessage(ws, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      return
    } finally {
      if (this.state.getWebSockets().length === 0) this.core.stopAsr('no-devices')
    }
  }

  async webSocketError(): Promise<void> {
    if (this.state.getWebSockets().length === 0) this.core.stopAsr('socket-error')
  }
}
