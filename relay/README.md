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

On a redeploy:

- Do **not** resend the `v1` migration. Send migrations only when the classes change.
- Add `"keep_bindings": ["secret_text"]` to the metadata so the secrets Fox has set survive the script upload. This is not yet verified on this Worker; check `/health` straight after the redeploy.
- Never list or print secret values.

## Layout

| File | What it does |
|---|---|
| `wrangler.jsonc` | Worker `kid-glasses-relay`; DO binding `HUB` → `RelayHub`; migration `v1` with `new_sqlite_classes` (the Workers Free plan only allows SQLite-backed DOs); non-secret vars |
| `src/index.ts` | Router: `GET /health`, `GET /device` (WebSocket), `POST /slack/events` |
| `src/hub.ts` | `RelayHub` Durable Object: WebSocket Hibernation API for devices (a per-socket attachment records `authed`), an alarm that closes sockets still unauthenticated after 10 s, SQLite-backed KV storage |
| `src/hub-core.ts` | Hub logic, runtime-free so it can be tested: sessions, threads, history, ASR flow, fast lane |
| `src/slack-verify.ts` | Slack signing-secret check (`v0:ts:body`, HMAC-SHA256, 5 min skew, constant-time compare) |
| `src/slack-events.ts` | Event routing for the bot-DM model (see "Inbound rules") |
| `src/slack-client.ts` | `chat.postMessage` with Fox's `xoxp-` token. It throws `ChannelNotAllowedError` for any channel except `KID_DM_CHANNEL_ID`, which must be a `D…` id, before any request is made |
| `src/sanitize.ts` | Outgoing: `〔眼镜〕` prefix, Slack `& < >` escaping (no mentions can form), control-char removal, 1500-char cap. Incoming: Slack markup to plain lens text, 2000-char cap |
| `src/deepgram.ts` | Streaming URL (`linear16`, 16 kHz, mono, `nova-3` + `multi`), result parsing, transcript joining (no spaces between CJK) |
| `src/history.ts` | Paged message history in DO storage, newest 500 kept |
| `src/device-auth.ts` | Device token check, done on the first WebSocket frame and never in the handshake |
| `src/protocol.ts` | Device message types and validation |
| `src/fast-lane.ts` | Fast-answer lane: **off** unless `FAST_LANE_ENABLED="true"` **and** `FAST_LLM_KEY` is set. The answer function is a stub. |

## Slack model (2026-11-25)

- **Workspace:** Your Workspace (`T0000000000`).
- **Fox:** the relay posts **as Fox** with his user token (`xoxp-`) into the DM between Fox and the **Kid bot**. Fox's user id (`U0000000000`) is not hardcoded; the relay resolves it lazily with `auth.test` and caches it.
- **Kid:** replies as a bot in that DM, in-thread or top-level.
- **Events:** the relay receives `message.im` as user events, which means for all of Fox's DMs. It considers only `KID_DM_CHANNEL_ID`.
- **Waking Kid:** the 2026-11-25 e2e showed that a user-token post does **not** wake Kid. Kid's Slack integration drops messages that carry `app_id` / `bot_profile` at the platform level. The relay therefore also calls Kid's webhook (next section).

## Outbound: Slack post + Kid webhook

For every glasses message, inside the post queue:

1. Post `〔眼镜〕…` into the Kid DM with the user token, exactly as before. This is the record and the thread root.
2. If `KID_WEBHOOK_URL` and `KID_WEBHOOK_SECRET` are both set, POST to Kid's webhook. If they are not set, the relay keeps post-only behaviour and reports the webhook as `skipped`.
3. Kid replies **as the Kid bot** in the same thread, or top-level. The existing `message.im` path pushes the reply to the glasses.

Webhook request:

```
POST <KID_WEBHOOK_URL>
Content-Type: application/json
X-Kid-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, t + "." + rawBody)>

{"v":1,"source":"kid-glasses","session":"<relay session id>","channel":"<KID_DM_CHANNEL_ID>","thread_ts":"<thread root ts>","message_ts":"<ts of this 〔眼镜〕 message>","text":"<transcript without the 〔眼镜〕 prefix>","at":<unix ms>}
```

- **Key:** the `KID_WEBHOOK_SECRET` string as UTF-8 bytes. A 64-hex-char secret is used as-is, not hex-decoded.
- **What is signed:** exactly the body bytes that are sent.
- **Text:** cleaned and clipped to 1500 characters. It is not HTML-escaped, unlike the Slack text.
- **`thread_ts` / `message_ts`:** within one session `thread_ts` stays the same and `message_ts` is new each time. On the first message both equal the root post's ts.
- **Timeout and retry:** 10 s per attempt. One retry, after 0.5 s, on 5xx or a network error or timeout. 4xx is never retried.
- **Failure:** it never undoes or blocks the Slack post or history.
  - The device gets `{"t":"kid-webhook","result":"failed","status":N|null}` plus `error kid-webhook-failed` with the message `kid webhook failed (<status|network>)`.
  - The log records only the status and the attempt count.
- **URL and secret** are never logged or sent to the device.
- **`/health`** reports `kidWebhook: true` only when both values are set and the URL is `https://`.

## Inbound rules

| Event in the Kid DM | Result |
|---|---|
| Plain message, `bot_message`, `me_message` from anyone but Fox | Forwarded to the glasses |
| `thread_broadcast` | Forwarded once, with its `thread_ts` |
| `file_share` | Text plus `[文件: name]`, or `[文件]` if the file has no name |
| `message_changed` with new delivered text | Appended as `（已修改）…`, with `edited: true` on the wire; history is not rewritten. "Delivered text" is `text`, or attachment text when `text` is empty; unfurl previews are excluded. The hub also stores the last delivered text per message `ts`, so an edit with the same text is dropped even when `previous_message` is missing |
| `message_changed` with the same text (e.g. unfurls) | Ignored |
| `message_deleted` | Ignored |
| Joins and other subtypes, hidden plain messages, empty text | Ignored |
| Fox's own messages | Ignored: by `authorizations` user id in the router, by `auth.test` user id in the hub, and any text starting with `〔眼镜〕` from a sender not verified by the allowlist. A pinned Kid reply that starts with the prefix is still forwarded |
| Optional allowlist `KID_BOT_ID` (`B…`) / `KID_BOT_USER_ID` (`U…`) | Plain vars, not secrets. When either is set, only that sender is forwarded |

The hub logs each new Kid sender pair once, as `kid sender user=… bot=…`. It logs ids only, never text, so the allowlist values can be read from the Worker's real-time logs.

**Session matching.** When the first glasses post of a session opens a thread, the hub stores `thread:<ts> → session`.

- A Kid reply with `thread_ts` goes to the session that owns that thread, even if a newer session has started.
- A top-level reply goes to the active session, or to none once it has expired. Only replies assigned to the active session extend its idle timer.
- Kid messages are processed one at a time (their own queue, separate from posts), so a Slack retry that arrives while `auth.test` is pending is delivered once.
- `msg` frames carry `session`.

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
| `KID_BOT_ID` / `KID_BOT_USER_ID` | var, optional | Pin the Kid bot identity (see "Inbound rules") |
| `KID_WEBHOOK_URL` | secret, optional | Kid's webhook routine (`https://…`) |
| `KID_WEBHOOK_SECRET` | secret, optional | HMAC key for `X-Kid-Signature` |

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
| `{"t":"ping"}` | Keep-alive. **Clients must send it about every 25 s.** In the 2026-11-25 e2e, a socket with no traffic was dropped (1006) after 270 s, and Cloudflare recorded it as a client-side disconnect |

**Relay → client**

| Message | Meaning |
|---|---|
| `auth.ok` | Authentication accepted |
| `hello` | Greeting, with `lastSeq` |
| `msg` | A message: `from` = `kid` / `glasses` / `fast`, plus `session`, and `edited` on edits |
| `asr.partial` / `asr.final` | Live and final transcript |
| `posted` | The message reached Slack |
| `kid-webhook` | `seq`, `result` = `ok` / `skipped` / `failed`, and `status`. Sent after each `posted` |
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

- **Event delivery.** It is not verified that Slack delivers `message.im` as a *user* event for every DM of the installing user, nor whether Fox's own messages come back. Fox is excluded three ways: the installing user from `authorizations` (router), the token owner from `auth.test` (hub), and any text starting with `〔眼镜〕`.
- **Deepgram auth header.** It is not verified that an `Authorization` header passes through a Worker's outbound `fetch` WebSocket upgrade. The Cloudflare docs only show `Upgrade`. If it does not, Deepgram also accepts the key as a WebSocket subprotocol.
- **ASR limits.** There is no limit on turn length and no `KeepAlive`. Deepgram closes a stream after about 10 s without audio. The device is expected to send `audio.stop` on release.
- **Plugin client.** The M1 plugin client (device-side WebSocket, entering `DEVICE_TOKEN` on the phone, paging replies with `LENS_TEXT`) is not written yet.
