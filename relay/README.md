# kid-glasses relay (M1 scaffold)

This relay is a Cloudflare Worker plus one Durable Object. It connects the G2 plugin to Slack:

- **Glasses → Kid.** Speech, or typed text, is posted into the Kid DM channel as Fox, using Fox's user token. Each post starts with `〔眼镜〕`.
- **Kid → glasses.** Kid's replies in that DM are pushed back to the glasses.

**Status: not deployed.** No Cloudflare resources exist for it yet. Fox's setup steps are in [`../docs/M1-FOX-SETUP.md`](../docs/M1-FOX-SETUP.md).

## Layout

| File | What it does |
|---|---|
| `wrangler.jsonc` | Worker `kid-glasses-relay`; DO binding `HUB` → `RelayHub`; migration `v1` with `new_sqlite_classes` (the Workers Free plan only allows SQLite-backed DOs); non-secret vars |
| `src/index.ts` | Router: `GET /health`, `GET /device` (WebSocket), `POST /slack/events` |
| `src/hub.ts` | `RelayHub` Durable Object: WebSocket Hibernation API for devices, SQLite-backed KV storage |
| `src/hub-core.ts` | Hub logic, runtime-free so it can be tested: sessions, threads, history, ASR flow, fast lane |
| `src/slack-verify.ts` | Slack signing-secret check (`v0:ts:body`, HMAC-SHA256, 5 min skew, constant-time compare) |
| `src/slack-events.ts` | Event routing: `url_verification`; `message` in the Kid DM only; skips edits, deletes, hidden messages and Fox's own posts |
| `src/slack-client.ts` | `chat.postMessage` with Fox's `xoxp-` token. It throws `ChannelNotAllowedError` for any channel except `KID_DM_CHANNEL_ID`, which must be a `D…` id, before any request is made |
| `src/sanitize.ts` | Outgoing: `〔眼镜〕` prefix, Slack `& < >` escaping (no mentions can form), control-char removal, 1500-char cap. Incoming: Slack markup to plain lens text, 2000-char cap |
| `src/deepgram.ts` | Streaming URL (`linear16`, 16 kHz, mono, `nova-3` + `multi`), result parsing, transcript joining (no spaces between CJK) |
| `src/history.ts` | Paged message history in DO storage, newest 500 kept |
| `src/device-auth.ts` | Device token check |
| `src/protocol.ts` | Device message types and validation |
| `src/fast-lane.ts` | Fast-answer lane: **off** unless `FAST_LANE_ENABLED="true"` **and** `FAST_LLM_KEY` is set. The answer function is a stub. |

## Configuration

Fox enters every secret himself, in the Cloudflare dashboard or with `wrangler secret put`. None is ever committed. For local dev, copy `.dev.vars.example` to `.dev.vars`, which is gitignored.

| Name | Kind | Meaning |
|---|---|---|
| `SLACK_USER_TOKEN` | secret | Fox's User OAuth Token (`xoxp-…`) |
| `SLACK_SIGNING_SECRET` | secret | Slack app signing secret |
| `KID_DM_CHANNEL_ID` | secret | The one DM channel the relay may post to (`D…`) |
| `DEEPGRAM_API_KEY` | secret | Deepgram key |
| `DEVICE_TOKEN` | secret | ≥ 32 chars, e.g. `openssl rand -hex 32` |
| `FAST_LLM_KEY` | secret, optional | Only used if the fast lane is enabled |
| `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | var | Default `nova-3` / `multi`. If Mandarin accuracy is poor, try `language=zh-CN`. |
| `FAST_LANE_ENABLED` | var | `"false"` |

`GET /health` reports which settings are present, as booleans only. Values are never echoed.

Each route fails closed when its secret is missing:

- `/slack/events` returns 503 without a signing secret.
- `/device` returns 503 without `DEVICE_TOKEN`.
- Posting throws `SlackConfigError` without a valid token or channel.

## Device protocol (`wss://<relay>/device`)

**Authentication.** The client offers the subprotocols `kg.v1` and `kg-token.<DEVICE_TOKEN>`. A browser `WebSocket` cannot set headers, so the token travels in a subprotocol. The relay answers with `kg.v1`. Non-browser clients may send `Authorization: Bearer <token>` instead.

**Client → relay**

| Message | Meaning |
|---|---|
| `{"t":"hello","lastSeq":N}` | The relay replies with `hello` and replays history after `N` |
| `{"t":"say","text":"…"}` | Post text to Kid |
| `{"t":"audio.start"}` | Start a speech turn |
| binary frames | PCM 16 kHz s16le mono, about 3200 B per 100 ms |
| `{"t":"audio.stop"}` | End the turn. Deepgram's final transcript is posted to Kid |
| `{"t":"history","before":seq,"limit":n}` | Fetch older messages |
| `{"t":"session.new"}` | Start a new Slack thread |
| `{"t":"ping"}` | Keep-alive |

**Relay → client**

| Message | Meaning |
|---|---|
| `hello` | Greeting, with `lastSeq` |
| `msg` | A message, `from` = `kid` / `glasses` / `fast` |
| `asr.partial` / `asr.final` | Live and final transcript |
| `posted` | The message reached Slack |
| `history` | A page of older messages |
| `error` | `code` and `message` |
| `pong` | Reply to `ping` |

**Sessions and threads.** The first post of a session starts a new Slack thread. Later posts reply in that thread. A session ends after 30 min idle, or on `session.new`.

## Develop

```bash
npm install
npm run typecheck
npm test
```

From the repo root, `npm run relay:test` does the same. Deployment will go through the Cloudflare MCP (no `wrangler login`) and only when Fox asks for it.

## Known gaps

These are unverified or not built yet:

- **Event delivery.** It is not verified that Slack delivers `message.im` as a *user* event for every DM of the installing user, nor whether Fox's own messages come back. The router already drops Fox's own user id and anything starting with `〔眼镜〕`.
- **Deepgram auth header.** It is not verified that an `Authorization` header passes through a Worker's outbound `fetch` WebSocket upgrade. The Cloudflare docs only show `Upgrade`. If it does not, Deepgram also accepts the key as a WebSocket subprotocol.
- **ASR limits.** There is no limit on turn length and no `KeepAlive`. Deepgram closes a stream after about 10 s without audio. The device is expected to send `audio.stop` on release.
- **Plugin client.** The M1 plugin client (device-side WebSocket, entering `DEVICE_TOKEN` on the phone, paging replies with `LENS_TEXT`) is not written yet.
