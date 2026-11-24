# kid-glasses relay (M1)

This relay is a Cloudflare Worker plus one Durable Object. It connects the G2 plugin to Slack:

- **Glasses → Kid.** Speech, or typed text, is posted into the Kid DM channel as Fox, using Fox's user token. Each post starts with `〔眼镜〕`.
- **Kid → glasses.** Kid's replies in that DM are pushed back to the glasses.

**Status: deployed 2026-11-25, no secrets set.**

- URL: <https://kid-glasses-relay.your-subdomain.workers.dev>
- Slack Events request URL: `https://kid-glasses-relay.your-subdomain.workers.dev/slack/events`
- Worker: `kid-glasses-relay`, Workers Free plan, workers.dev only.
- Durable Object namespace: `kid-glasses-relay_RelayHub`, class `RelayHub`, SQLite storage. Migration `v1` (`new_sqlite_classes`) is applied.
- Plain-text vars only: `DEEPGRAM_MODEL=nova-3`, `DEEPGRAM_LANGUAGE=multi`, `FAST_LANE_ENABLED=false`.

Fox's setup steps are in [`../docs/M1-FOX-SETUP.md`](../docs/M1-FOX-SETUP.md).

### How it was deployed

There was no `wrangler login`; the deploy went through the Cloudflare MCP:

1. Bundle locally:

   ```bash
   node_modules/.bin/esbuild relay/src/index.ts --bundle --format=esm --platform=neutral --target=es2022 --minify --outfile=$TMPDIR/relay/index.js
   ```

2. Pass the file to the MCP as base64. Inside the MCP, check its sha256 before uploading.
3. `PUT /accounts/{id}/workers/scripts/kid-glasses-relay`, multipart, with this metadata:
   - `main_module: index.js`
   - `compatibility_date: 2026-11-01`
   - bindings: `durable_object_namespace HUB → RelayHub`, plus the three `plain_text` vars
   - `migrations: {new_tag: "v1", new_sqlite_classes: ["RelayHub"]}`
4. Enable the workers.dev route: `POST …/subdomain {enabled: true}`.

On a redeploy, do **not** resend the `v1` migration. Send migrations only when the classes change. Redeploying the script does not touch secrets Fox has set.

## Layout

| File | What it does |
|---|---|
| `wrangler.jsonc` | Worker `kid-glasses-relay`; DO binding `HUB` → `RelayHub`; migration `v1` with `new_sqlite_classes` (the Workers Free plan only allows SQLite-backed DOs); non-secret vars |
| `src/index.ts` | Router: `GET /health`, `GET /device` (WebSocket), `POST /slack/events` |
| `src/hub.ts` | `RelayHub` Durable Object: WebSocket Hibernation API for devices (a per-socket attachment records `authed`), an alarm that closes sockets still unauthenticated after 10 s, SQLite-backed KV storage |
| `src/hub-core.ts` | Hub logic, runtime-free so it can be tested: sessions, threads, history, ASR flow, fast lane |
| `src/slack-verify.ts` | Slack signing-secret check (`v0:ts:body`, HMAC-SHA256, 5 min skew, constant-time compare) |
| `src/slack-events.ts` | Event routing: `url_verification`; `message` in the Kid DM only; skips edits, deletes, hidden messages and Fox's own posts |
| `src/slack-client.ts` | `chat.postMessage` with Fox's `xoxp-` token. It throws `ChannelNotAllowedError` for any channel except `KID_DM_CHANNEL_ID`, which must be a `D…` id, before any request is made |
| `src/sanitize.ts` | Outgoing: `〔眼镜〕` prefix, Slack `& < >` escaping (no mentions can form), control-char removal, 1500-char cap. Incoming: Slack markup to plain lens text, 2000-char cap |
| `src/deepgram.ts` | Streaming URL (`linear16`, 16 kHz, mono, `nova-3` + `multi`), result parsing, transcript joining (no spaces between CJK) |
| `src/history.ts` | Paged message history in DO storage, newest 500 kept |
| `src/device-auth.ts` | Device token check, done on the first WebSocket frame and never in the handshake |
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
- `/device` returns 503 without `DEVICE_TOKEN`; a socket whose first frame is not a valid `auth` is closed with 4401 (4503 if the token is unset).
- Posting throws `SlackConfigError` without a valid token or channel.

## Device protocol (`wss://<relay>/device`)

**Authentication.**

1. The client connects with the public subprotocol `kg.v1` only. No secret goes in the handshake, because request headers can show up in Cloudflare request traces.
2. Its first frame must be `{"t":"auth","token":"<DEVICE_TOKEN>"}`. The relay answers `auth.ok`.
3. Until then the socket receives nothing:
   - no broadcasts, history or replies;
   - any other frame closes it with 4401;
   - an alarm closes it after 10 s.

**Client → relay**

| Message | Meaning |
|---|---|
| `{"t":"auth","token":"…"}` | Must be the first frame |
| `{"t":"hello","lastSeq":N}` | The relay replies with `hello` and replays every retained message after `N` |
| `{"t":"say","text":"…"}` | Post text to Kid |
| `{"t":"audio.start"}` | Start a speech turn |
| binary frames | PCM 16 kHz s16le mono, about 3200 B per 100 ms |
| `{"t":"audio.stop"}` | End the turn. Deepgram's final transcript is posted to Kid. If the stream fails or closes before the stop, the relay sends `error asr-interrupted` and posts nothing |
| `{"t":"history","before":seq,"limit":n}` | Fetch older messages |
| `{"t":"session.new"}` | Start a new Slack thread |
| `{"t":"ping"}` | Keep-alive |

**Relay → client**

| Message | Meaning |
|---|---|
| `auth.ok` | Authentication accepted |
| `hello` | Greeting, with `lastSeq` |
| `msg` | A message, `from` = `kid` / `glasses` / `fast` |
| `asr.partial` / `asr.final` | Live and final transcript |
| `posted` | The message reached Slack |
| `history` | A page of older messages |
| `error` | `code` and `message` |
| `pong` | Reply to `ping` |

**Sessions and threads.** The first post of a session starts a new Slack thread. Later posts reply in that thread. A session ends after 30 min idle, or on `session.new`.

- Posts, session changes and session refreshes run through one queue, so a session never opens two threads.
- An in-flight post cannot undo `session.new`.
- A late Kid reply cannot revive an expired session.

**Slack delivery.** `/slack/events` waits for the DO to store the message before it returns 200. On failure it returns 500, so Slack retries. The history entry is written before the event id is marked seen.

## Develop

```bash
npm install
npm run typecheck
npm test
```

From the repo root, `npm run relay:test` does the same. Deployment will go through the Cloudflare MCP (no `wrangler login`) and only when Fox asks for it.

## Review

Cross-family review (GPT diff-review):

**Round 1:** 1 BLOCK and 7 FIX_NEXT, all fixed in `a3f3f82`.

- The BLOCK: the device token travelled in the WebSocket handshake. It now goes in the first frame.
- The FIX_NEXT issues: Slack acked before the message was stored; session and thread races; replay capped at 50; overlapping or failed ASR turns; close code 1005; the prefix filter dropping Kid replies; emoji stripping eating `12:30:45`.

**Round 2:** confirmed F1, F3, F4, F6 and F8 fixed, with no new leak, auth bypass, or post outside the Kid DM. It flagged 5 FIX_NEXT, now fixed:

- History entry and seen marker are written in one atomic `put`.
- A Kid reply is stored without waiting for an in-flight Slack post.
- An ASR close other than 1000 is never posted.
- Transcripts post in the order their turns started.
- Fox's own messages are identified by `auth.test` on the user token, not by `authorizations` or the prefix.

Each finding has a regression test in `test/`. The round-2 fixes were verified by those tests only. They were not sent back for a third review.

## Known gaps

These are unverified or not built yet:

- **Event delivery.** It is not verified that Slack delivers `message.im` as a *user* event for every DM of the installing user, nor whether Fox's own messages come back. The router drops the installing user from `authorizations`. The hub also drops anything sent by the token's own user (looked up once with `auth.test`). The `〔眼镜〕` prefix is never used as a filter.
- **Deepgram auth header.** It is not verified that an `Authorization` header passes through a Worker's outbound `fetch` WebSocket upgrade. The Cloudflare docs only show `Upgrade`. If it does not, Deepgram also accepts the key as a WebSocket subprotocol.
- **ASR limits.** There is no limit on turn length and no `KeepAlive`. Deepgram closes a stream after about 10 s without audio. The device is expected to send `audio.stop` on release.
- **Plugin client.** The M1 plugin client (device-side WebSocket, entering `DEVICE_TOKEN` on the phone, paging replies with `LENS_TEXT`) is not written yet.
