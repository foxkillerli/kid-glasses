export class ChannelNotAllowedError extends Error {
  constructor() {
    super('refusing to post: only the configured Kid DM channel is allowed')
    this.name = 'ChannelNotAllowedError'
  }
}

export class SlackConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackConfigError'
  }
}

export class SlackApiError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`slack api error: ${code}`)
    this.name = 'SlackApiError'
  }
}

export class SlackTimeoutError extends Error {
  constructor() {
    super('slack api call timed out')
    this.name = 'SlackTimeoutError'
  }
}

export const SLACK_TIMEOUT_MS = 10_000
export const RECONCILE_MAX_PAGES = 5

export interface PostResult {
  ts: string
  channel: string
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

const DM_CHANNEL = /^D[A-Z0-9]{6,}$/

interface SlackReply {
  status: number
  retryAfter: string | null
  data: Record<string, unknown> | null
}

export class KidDmClient {
  constructor(
    private readonly userToken: string | undefined,
    private readonly kidChannelId: string | undefined,
    private readonly fetchFn: FetchFn = (i, r) => fetch(i, r),
    private readonly timeoutMs: number = SLACK_TIMEOUT_MS,
  ) {}

  private async once(url: string, init: RequestInit): Promise<SlackReply> {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort()
        reject(new SlackTimeoutError())
      }, this.timeoutMs)
    })
    const work = (async (): Promise<SlackReply> => {
      const res = await this.fetchFn(url, { ...init, signal: ctrl.signal })
      const retryAfter = res.headers.get('Retry-After')
      if (res.status === 429) return { status: 429, retryAfter, data: null }
      return { status: res.status, retryAfter, data: (await res.json()) as Record<string, unknown> }
    })()
    try {
      return await Promise.race([work, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async readOnly(url: string, init: RequestInit): Promise<SlackReply> {
    try {
      const r = await this.once(url, init)
      if (r.status < 500) return r
    } catch (err) {
      if (err instanceof SlackApiError) throw err
    }
    return this.once(url, init)
  }

  assertAllowed(channel: string): void {
    if (!this.kidChannelId || !DM_CHANNEL.test(this.kidChannelId)) {
      throw new SlackConfigError('KID_DM_CHANNEL_ID is missing or is not a DM channel id (D…)')
    }
    if (channel !== this.kidChannelId) throw new ChannelNotAllowedError()
  }

  async postMessage(channel: string, text: string, threadTs: string | null): Promise<PostResult> {
    this.assertAllowed(channel)
    if (!this.userToken || !this.userToken.startsWith('xoxp-')) {
      throw new SlackConfigError('SLACK_USER_TOKEN is missing or is not a user token (xoxp-)')
    }
    const body: Record<string, unknown> = { channel, text, unfurl_links: false, unfurl_media: false }
    if (threadTs) body.thread_ts = threadTs
    const res = await this.once('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.userToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    if (res.status === 429) throw new SlackApiError('ratelimited', Number(res.retryAfter ?? '1'))
    const data = (res.data ?? {}) as { ok?: boolean; error?: string; ts?: string; channel?: string }
    if (!data.ok || !data.ts) throw new SlackApiError(data.error ?? `http_${res.status}`)
    if (data.channel && data.channel !== this.kidChannelId) throw new ChannelNotAllowedError()
    return { ts: data.ts, channel: data.channel ?? channel }
  }

  private selfId: Promise<string | null> | null = null

  selfUserId(): Promise<string | null> {
    if (!this.selfId) {
      this.selfId = this.lookupSelf()
      this.selfId.then(id => {
        if (!id) this.selfId = null
      })
    }
    return this.selfId
  }

  private async lookupSelf(): Promise<string | null> {
    if (!this.userToken || !this.userToken.startsWith('xoxp-')) return null
    try {
      const res = await this.readOnly('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.userToken}` },
      })
      const data = (res.data ?? {}) as { ok?: boolean; user_id?: string }
      return data.ok && typeof data.user_id === 'string' ? data.user_id : null
    } catch {
      return null
    }
  }

  async findOwnPost(text: string, threadTs: string | null, sinceMs: number, excludeTs: Set<string> = new Set()): Promise<PostResult | null> {
    const channel = this.kidChannelId ?? ''
    this.assertAllowed(channel)
    if (!this.userToken || !this.userToken.startsWith('xoxp-')) throw new SlackConfigError('SLACK_USER_TOKEN is missing or is not a user token (xoxp-)')
    const self = await this.selfUserId()
    if (!self) throw new SlackApiError('self_unknown')
    const oldest = (Math.floor(sinceMs / 1000) - 60).toString()
    const method = threadTs ? 'conversations.replies' : 'conversations.history'
    let cursor = ''
    for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
      const params = new URLSearchParams({ channel, oldest, limit: '200', inclusive: 'true' })
      if (threadTs) params.set('ts', threadTs)
      if (cursor) params.set('cursor', cursor)
      const res = await this.readOnly(`https://slack.com/api/${method}?${params}`, { method: 'GET', headers: { Authorization: `Bearer ${this.userToken}` } })
      if (res.status === 429) throw new SlackApiError('ratelimited', Number(res.retryAfter ?? '1'))
      const data = (res.data ?? {}) as {
        ok?: boolean
        error?: string
        messages?: Array<{ ts?: string; user?: string; text?: string }>
        response_metadata?: { next_cursor?: string }
      }
      if (!data.ok) throw new SlackApiError(data.error ?? `http_${res.status}`)
      const hit = (data.messages ?? []).find(m => m.user === self && m.text === text && typeof m.ts === 'string' && !excludeTs.has(m.ts))
      if (hit) return { ts: hit.ts as string, channel }
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor : ''
      if (!cursor) return null
    }
    throw new SlackApiError('reconcile_too_many_pages')
  }

  postToKid(text: string, threadTs: string | null): Promise<PostResult> {
    return this.postMessage(this.kidChannelId ?? '', text, threadTs)
  }
}
