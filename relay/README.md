# kid-glasses relay (M1)

This relay is a Cloudflare Worker plus one Durable Object. It connects the G2 plugin to Slack:

- **Glasses → Kid.** Speech, or typed text, is posted into the Kid DM channel as Fox, using Fox's user token. Each post starts with `〔眼镜〕`.
- **Kid → glasses.** Kid's replies in that DM are pushed back to the glasses.

**Status (2026-11-25): deployed and configured.** Seven secrets are set by Fox: `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, `KID_DM_CHANNEL_ID`, `DEEPGRAM_API_KEY`, `DEVICE_TOKEN`, `KID_WEBHOOK_URL`, `KID_WEBHOOK_SECRET`. Workers Logs are on (`observability.enabled`, `head_sampling_rate 1`). Devices pair through Fox's Slack DM (see "Device pairing").

- URL: <https://kid-glasses-relay.your-subdomain.workers.dev>
- Slack Events request URL: `https://kid-glasses-relay.your-subdomain.workers.dev/slack/events`
- Worker: `kid-glasses-relay`, Workers Free plan, workers.dev only.
- Durable Object namespace: `kid-glasses-relay_RelayHub`, class `RelayHub`, SQLite storage. Migration `v1` (`new_sqlite_classes`) is applied.
- Plain-text vars only: `DEEPGRAM_MODEL=nova-3`, `DEEPGRAM_LANGUAGE=multi`, `DEEPGRAM_LANGUAGE_HINTS=zh,en`, `FAST_LANE_ENABLED=false`.

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
- Add `"keep_bindings": ["secret_text"]` to the metadata so the secrets Fox has set survive the script upload. Verified twice on 2026-11-25: the secret names were the same before and after, and `/health` stayed true.
- Send `"observability": {"enabled": true, "head_sampling_rate": 1}` in the metadata, to match `wrangler.jsonc`.
- Check `/health` straight after the redeploy, and compare the names of the secret bindings before and after.
- Never list or print secret values.

## Layout

| File | What it does |
|---|---|
| `wrangler.jsonc` | Worker `kid-glasses-relay`; DO binding `HUB` → `RelayHub`; migration `v1` with `new_sqlite_classes` (the Workers Free plan only allows SQLite-backed DOs); non-secret vars |
| `src/index.ts` | Router: `GET /health`, `GET /device` (WebSocket), `POST /slack/events` |
| `src/hub.ts` | `RelayHub` Durable Object: WebSocket Hibernation API for devices (a per-socket attachment records `authed`), an alarm that closes sockets still unauthenticated after 10 s (`sweepUnauthed` in `src/device-auth.ts`, 100 ms slack, re-armed for the earliest remaining deadline), SQLite-backed KV storage |
| `src/hub-core.ts` | Hub logic, runtime-free so it can be tested: sessions, threads, history, ASR flow, fast lane |
| `src/slack-verify.ts` | Slack signing-secret check (`v0:ts:body`, HMAC-SHA256, 5 min skew, constant-time compare) |
| `src/slack-events.ts` | Event routing for the bot-DM model (see "Inbound rules") |
| `src/slack-client.ts` | `chat.postMessage` with Fox's `xoxp-` token. It throws `ChannelNotAllowedError` for any channel except `KID_DM_CHANNEL_ID`, which must be a `D…` id, before any request is made |
| `src/sanitize.ts` | Outgoing: `〔眼镜〕` prefix, Slack `& < >` escaping (no mentions can form), control-char removal, 1500-char cap. Incoming: Slack markup to plain lens text, 2000-char cap |
| `src/deepgram.ts` | Streaming URL per turn language (`linear16`, 16 kHz, mono; `auto` = `nova-3` + `multi` + `language_hint` zh/en, `zh` = `zh-CN`, `en` = `en`), message parsing, transcript joining (no spaces between CJK) |
| `src/asr-turn.ts` | One voice turn against Deepgram: connect timeout and fallback, KeepAlive, Finalize on stop, final-wait timeout, reconnect with replay of unfinalized audio, watchdogs, content-free metrics. See [`docs/M2-PLAN.md`](../docs/M2-PLAN.md) |
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
| `DEEPGRAM_MODEL` / `DEEPGRAM_LANGUAGE` | var | Default `nova-3` / `multi`. `DEEPGRAM_LANGUAGE` is used for the plugin's `自动` setting; `中文` always uses `zh-CN` and `English` uses `en`. |
| `DEEPGRAM_LANGUAGE_HINTS` | var | Default `zh,en`. Sent as `language_hint` only with `multi`. Invalid codes are dropped; if Deepgram still rejects the URL with HTTP 400, the turn falls back to `nova-3` + `multi` without hints. |
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
| `{"t":"auth","token":"…"}` | Must be the first frame. `token` is `DEVICE_TOKEN` or a paired device token (`kgd_…`) |
| `{"t":"hello","lastSeq":N}` | The relay replies with `hello` and replays every retained message after `N` |
| `{"t":"say","text":"…","cid":"…"}` | Post text to Kid. `cid` (8–64 of `A-Za-z0-9_-`, e.g. a UUID) is optional. A repeated `cid` is not posted again: the relay re-acks with `posted {seq, cid, dup: true}` |
| `{"t":"audio.start","cid":"…","lang":"auto"}` | Start a speech turn. `lang` is `auto` (default), `zh` or `en`; anything else gets `error bad-message bad-lang`. The transcript is posted with this `cid`. The turn belongs to that socket: audio, `audio.stop` and `audio.cancel` from other devices are ignored, and a second `audio.start` gets `error asr-busy` |
| binary frames | PCM 16 kHz s16le mono, about 3200 B per 100 ms |
| `{"t":"audio.cancel"}` | Abandon the turn: nothing is posted. The relay also cancels a turn whose owner socket closes before `audio.stop` |
| `{"t":"audio.stop"}` | End the turn. The relay sends `Finalize`, posts as soon as Deepgram's `from_finalize` result arrives (or on the close after `CloseStream`), and after 5 s posts what the lens showed. A Deepgram drop is retried twice with the unfinalized audio; after that the relay sends `error asr-interrupted` and posts nothing |
| `{"t":"history","before":seq,"limit":n}` | Fetch older messages |
| `{"t":"session.new"}` | Start a new Slack thread |
| `{"t":"ping"}` | Keep-alive. **Clients must send it about every 25 s.** In the 2026-11-25 e2e, a socket with no traffic was dropped (1006) after 270 s, and Cloudflare recorded it as a client-side disconnect |

**Relay → client**

| Message | Meaning |
|---|---|
| `auth.ok` | Authentication accepted |
| `hello` | Greeting, with `lastSeq` |
| `replay.done` | `{upTo}`: the replay after `hello {lastSeq}` is complete. The plugin persists its cursor only after this frame, so live frames that arrive during the replay cannot make it skip a gap |
| `msg` | A message: `from` = `kid` / `glasses` / `fast`, plus `session`, and `edited` on edits |
| `asr.partial` / `asr.final` | Live and final transcript, with the turn's `cid`. The plugin ignores transcripts of any other turn |
| `posted` | The message reached Slack: `seq`, `text`, `cid` if one was given, `dup: true` for a re-ack |
| `kid-webhook` | `seq`, `result` = `ok` / `skipped` / `failed`, and `status`. Sent after each `posted` |
| `history` | A page of older messages |
| `error` | `code`, `message`, and `cid` when the error belongs to a turn (`asr-interrupted`, `asr-empty`, `asr-connect-failed`, `asr-rejected` for Deepgram HTTP 401/402/403, `asr-no-audio` after 10 s without frames, Slack post failures). Before closing an unauthenticated socket the relay sends `auth-timeout` (M3) |
| `turn.pending` | M3: `{cid, text}` of a voice transcript whose Slack post failed transiently. Sent when it fails and again after each `hello`. The device resends it as `say {cid, text}`; the relay clears it once that cid posts (or reconciles) |
| `pong` | Reply to `ping` |

**Resend without double posting.** The plugin keeps every `say` it has not seen acknowledged in a persisted outbox. After each reconnect, and after a page reload, it sends them again with the same `cid`.

- The relay keeps `meta:cids` (at most 1000 entries, 24 h; the plugin drops unsent turns after 12 h). Every post runs through one queue, so concurrent duplicates also post once.
- Before calling Slack, the relay marks the cid `sending`. The outcome then decides the next step:
  - **Success:** the mark becomes `posted`, atomically with the history entry.
  - **Definite refusal** (Slack answered `ok:false`, or a config error): the mark is removed, so a resend posts normally.
  - **Uncertain** (network error, or the DO died mid-call): the mark stays. On the resend the relay first looks for its own message with the same text in that thread or the DM (`conversations.replies` / `conversations.history`, `im:history`). If it finds one, it records that post and calls the webhook; if not, it posts. If Slack cannot be checked, it posts nothing and reports `slack-unreachable`.
- The plugin retries errors that are not permanent on the same socket, after 10 s, 30 s and 90 s, with the same cid. A turn is given up after 4 errors.
- Reconcile skips Slack messages already recorded for another cid, so two turns with the same text in one thread are never confused. A reconciled post keeps its original session and thread.
- Voice turns (M3): if the Slack post of a transcript fails with anything but a config/channel refusal, the relay keeps `{cid, text}` in `meta:voice-pending` (at most 20, 12 h) and offers it as `turn.pending`. The plugin adopts it into its outbox, so it follows the same retry and dedupe rules as a typed `say`.
- Every Slack API call has a 10 s deadline that covers the body too (`SlackTimeoutError`). `chat.postMessage` is never retried inside the call; a timeout counts as uncertain. `auth.test` and `conversations.*` retry once on a timeout, network error or 5xx.
- Reconcile follows `next_cursor` for up to 5 pages of 200 messages. If it is still not sure after 5 pages it posts nothing and reports `slack-unreachable`.
- A duplicate is answered from history and never calls Slack or the Kid webhook.
- `msg` / `history` items for glasses turns carry their `cid`, so a replay clears the outbox as well.
- A voice turn cannot be resent from the device: the audio is kept only on the relay, for at most 15 s of not-yet-finalized speech, to survive a Deepgram drop. If the device socket drops mid-turn, the turn is cancelled.

**Sessions and threads.** The first post of a session starts a new Slack thread. Later posts reply in that thread. A session ends after 30 min idle, or on `session.new`.

- Posts, session changes and session refreshes run through one queue, so a session never opens two threads.
- An in-flight post cannot undo `session.new`.
- A late Kid reply cannot revive an expired session.

**Slack delivery.** `/slack/events` waits for the DO to store the message before it returns 200. On failure it returns 500, so Slack retries. The history entry is written before the event id is marked seen.

## Device pairing

The device token never passes through a chat and is not in the public bundle. A device gets its own token by pairing:

1. The plugin, which has no token yet, calls `POST /pair/start`.
   - The relay answers `{pairId, code, expiresAt}`: `pairId` is 128 random bits, `code` is 6 digits, and the pairing expires after 5 min.
   - Limits: 3 starts per minute per client, and at most 5 active pairings. The client key is `sha256(CF-Connecting-IP)[:16]`, kept in memory only and never logged.
2. The lens shows the code. Fox types `配对 123456` by hand in the Fox ↔ Kid DM.
3. The router treats it as a confirmation only if **all** of these hold:
   - It is in `KID_DM_CHANNEL_ID`.
   - It has no `subtype`, `bot_id`, `app_id`, `bot_profile` or `hidden`. The relay's own user-token posts carry `app_id` / `bot_profile`, so they can never confirm.
   - The sender is the installing user from `authorizations`, if present.
4. The hub then requires `user == auth.test user id` (Fox).
5. The code is compared in constant time and is single use.
   - The message time must fall within that pairing's lifetime (allowing 10 s of skew).
   - Each confirming message (`pair:<message ts>`) is processed once, so Slack redeliveries change nothing.
   - After 5 wrong codes within 10 min, confirmations are locked for 10 min and pending pairings are cleared.
   - Each client can hold at most 2 pending pairings.
6. The plugin polls `POST /pair/poll {pairId}` (60 per minute per client). Once Fox has confirmed, the relay mints `kgd_<64 hex>` and returns it **once** as `{status: "paired", token, deviceId}`. It stores only the token's sha256, in `pair:devices` (at most 10 devices). When an 11th device pairs, the oldest is dropped and its open sockets are closed with 4401 `evicted`.
7. The plugin keeps the token in the SDK's local storage (`bridge.setLocalStorage`).

Device auth accepts `DEVICE_TOKEN` or a paired token. A rejected paired token (close 4401) makes the plugin forget it and pair again.

**Revoking.**

- Fox sends `撤销配对` in the same DM, with the same checks as above. Every device whose pairing Fox confirmed before that message is deleted, even if it collected its token after the revoke was sent, and its sockets are closed with 4401 `revoked`. A redelivered or late revoke cannot remove devices confirmed after it.
- Rotating `DEVICE_TOKEN` does **not** revoke paired tokens, and `撤销配对` does not affect `DEVICE_TOKEN`.
- Fallback without Slack: delete the DO storage keys `pair:devices` and `pair:pending`. The other DO keys (history, session) are unaffected.

**Notes.**

- The `配对` / `撤销配对` messages are never shown on the glasses and are not glasses turns.
- Kid also sees them in the DM and may reply. That reply is shown on the glasses like any other Kid message.
- CORS on `/pair/*` is `*` (no cookies are involved). The plugin sends `Content-Type: text/plain`, so there is no preflight; `OPTIONS` is answered anyway.

## Logging (Workers Logs)

`console.log` lines start with `[relay]`.

- **Allowed in logs:** event kinds, drop reasons, internal ids (`seq`, device id), HTTP status codes, attempt counts, text lengths. Slack user/bot ids appear once per Kid sender, for the allowlist.
- **Never logged:** message text, transcripts, Slack event bodies, tokens, secrets, the webhook URL, `DEVICE_TOKEN`, paired tokens, pair codes, pair ids, channel ids, client IPs.
- Fox's DMs with other people are dropped silently (`other-channel` is not logged).
- Errors whose message we do not control (for example a thrown `fetch` error) reach the device only as a generic message, and the log gets only the error name.
- `test/log-guard.test.ts` spies on `console.*` and drives say, Slack post failures, the webhook, device auth, Kid replies, ASR failure, pairing and the Worker entry routes with sentinel values. It asserts that none of them appear in the logs.
- Cloudflare's own invocation log also records request metadata such as the URL and method. Which headers it records is not verified. By design no secret travels in a URL or header: the device token is the first WebSocket frame, and pair ids are in POST bodies.

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
- **ASR limits.** The relay stops a turn after 62 s of audio (the plugin stops at 60 s). Retry, timeouts and the chosen Deepgram config are in [`docs/M2-PLAN.md`](../docs/M2-PLAN.md). The Deepgram `Authorization` header through the outbound upgrade is confirmed by M1's device test.
- **Unauthenticated close timing.** The alarm closes an idle unauthenticated socket about 10.1 s after it connects. A client that just waits sees the close frame then, but its `close` event only fires about 10 s later, when the TCP connection is torn down after the server-initiated close (measured 2026-11-25: close frame at 10.5 s, `close` event at 20.6 s; a client-initiated close takes 20–280 ms). The `auth-timeout` frame lets a client close its own side at once; the plugin does.
- **Slack.** M3 bounds every Slack call, but a Slack outage longer than the plugin's retry schedule still ends with the turn dropped from the outbox (the relay offers a pending voice transcript again after the next `hello`, for 12 h).
