# M3 plan: polish

Written 2026-11-25 on branch `m3`, cut from `main` at `d893b39`, which is what M2 runs on. Nothing in M3 is deployed until user's M2 device test is done and M3 is approved. All M1/M2 protocol messages keep their meaning; M3 only adds optional fields and one new server message.

## Audit (before M3)

1. **Slack calls have no deadline** (codex M2-6). `chat.postMessage`, `conversations.replies`, `conversations.history` and `auth.test` use bare `fetch`. A hung response, or a body that never finishes, keeps `postNow` waiting. Every later post queues behind it (`HubCore.queue`), and voice turns wait in `turnChain`, so nothing more reaches Kid until the Durable Object restarts.
2. **Unauthenticated sockets "close at ~21 s".** Measured live on 2026-11-25 (Node `WebSocket` client, sending nothing):
   - Workers Logs: the `/device` fetch at `…906.474`, the `alarm` at `…917.076` (10.6 s later), and the DO `close` event at `…917.096`.
   - Client: the close frame arrives (`readyState` CLOSING) 10.5 s after open; the `close` event fires at 20.6 s; code 4401 `auth timeout`, `wasClean: true`.
   - A client-initiated close takes 283 ms on the relay and 20 ms on the echo worker.
   - So the auth timer is right. The extra ~10 s is the TCP teardown after a server-initiated close handshake, which the server cannot shorten. The runtime already auto-replies to close frames (compatibility date ≥ 2026-04-07).
3. **A voice transcript is lost when Slack fails.** The transcript exists only in the relay. If `chat.postMessage` fails transiently (network, timeout, rate limit), the relay sends an error with the `cid` and forgets the text. The plugin's outbox only holds typed `say` messages, so nothing retries.
4. **Reconcile reads one page.** On a resend of an uncertain post, `findOwnPost` reads at most 200 messages of the thread or DM. In a long thread the earlier post can be on a later page, and the relay posts a duplicate.
5. **UX gaps.**
   - Starting a new Slack thread needs 30 min idle; there is no way to do it from the glasses.
   - When browsing older pages, nothing on the lens says there is newer content below.
   - The outbox count `待发N` does not say whether it is waiting for the network or retrying.
6. **Stale docs.** `relay/README.md` "Known gaps" still says the plugin client is not written; "Not covered" still says a rejected voice turn is not retried.

## Scope

1. **M3-1 Slack deadlines** (`relay/src/slack-client.ts`).
   - Every Slack call runs under a 10 s deadline that covers both the response and the body, enforced with an `AbortController` and a timer race, so even a fetch that ignores the abort cannot hang.
   - A timeout throws `SlackTimeoutError`. For `chat.postMessage` this counts as **uncertain**: the cid stays marked, and the resend reconciles first.
   - `chat.postMessage` is never retried inside the call (a retry could double-post).
   - The read-only calls (`auth.test`, `conversations.*`) retry once on a timeout, a network error or HTTP 5xx.
2. **M3-2 Unauthenticated socket close.**
   - The relay sends `{"t":"error","code":"auth-timeout"}` before it closes, so a client knows at ~10 s and can close its own side, which is fast.
   - The alarm slack drops from 500 ms to 100 ms, and an alarm that finds sockets still inside the window re-arms for the earliest deadline instead of `now + 1 s`.
   - The plugin closes its own socket when it gets `auth-timeout` or `unauthorized` (it normally authenticates in the first frame, so this is a safety net).
   - The remaining client-observed teardown is documented, not hidden.
3. **M3-3 Recoverable voice transcripts.**
   - When a voice post fails with anything but a permanent error, the relay keeps `{cid, text}` in storage (`meta:voice-pending`, at most 20 entries, 12 h).
   - It sends `{"t":"turn.pending","cid","text"}` to live devices at once, and again to every device after `hello` replay.
   - The plugin adopts it into its persisted outbox and resends it as `say {cid, text}` on its normal retry schedule.
   - The relay's cid dedupe and reconcile prevent a double post. A successful post, or a permanent refusal, removes the pending entry.
   - Old plugins ignore `turn.pending`.
4. **M3-4 Reconcile pagination.** `findOwnPost` follows `response_metadata.next_cursor` for up to 5 pages of 200 (1000 messages), bounded by the same `oldest` cutoff as before, and stops at the first match.
5. **M3-5 UX and docs.**
   - Menu item `新对话`: sends `session.new`, returns to the Kid page and says `已开始新对话（Slack 新话题）`.
   - When the current page is not the last, the hint shows `↓ 下面还有 下滑查看 N/M` (after browsing back, or after skipping a Kid reveal on an early page). Tapping to talk or new content still jumps to the newest page; nothing auto-jumps on a timer.
   - The status line shows `待发N` while waiting for the network and `重发N` while a retry is scheduled.
   - Copy: `slack-unreachable` says the text will be resent automatically.
   - The README files are brought up to date.
6. **Guards.** The relay log guard covers the new paths (timeouts, pending voice, pagination). A new plugin test checks that the phone-page log never contains transcript text, tokens or pairing codes.

## Not in scope

- No deploy, no Cloudflare settings or secret changes.
- No protocol change that an M2 plugin or relay would misread.

## Deploy later (after user's M2 test)

Same recipe as M2: the relay with `keep_bindings: ["secret_text"]` and no migration, then the plugin to `kid-glasses-m0`. Deploy the relay first: the new plugin also works with the M2 relay, just without `turn.pending`.

## Review

- **Round 1** (codex gpt-6.2-sol, critical-review, change `m3-polish`): FAIL, 1 BLOCK, 5 FIX_NEXT, 1 NOTE.
- **BLOCK M3-01**: one voice cid could produce two Slack posts. Fixed:
  - Slack errors that can follow a write (`internal_error`, `fatal_error`, `request_timeout`, `service_unavailable`, `http_5xx`) count as uncertain, so the resend reconciles first.
  - A resend of an uncertain cid that reconciles to nothing within 30 s of the failure posts nothing (`slack-unreachable`, retried later), so a late-landing first write is found next time.
  - Reconcile refuses to guess when Slack says `has_more` without a cursor.
  - Reconcile compares text with Slack's link formatting (`<url|label>`, `<mailto:…>`) removed.
  - The plugin flushes its outbox after `replay.done`, not at `auth.ok`, so a post it missed the ack for is acked by the replay first (5 s fallback if no `replay.done` arrives).
  - **Residual, documented:** a duplicate is still possible when all of these hold: the phone holds a `say` that did reach Slack but whose ack it missed, the relay then takes more than 1000 newer posts (the cid record cap) and 500 (history), and the phone reconnects within its 12 h outbox window. Closing that needs per-cid storage keys and is left for a later change.
- **FIX_NEXT fixed:**
  - M3-02: the pending text fits the device's UTF-16 limit, and a permanent refusal on a resend clears the pending entry.
  - M3-03: reconcile excludes every glasses post in recent history (four pages of 50), including ones sent without a cid.
  - M3-04: a pending voice resend goes to the session and thread of its first attempt.
  - M3-05: an adopted transcript shows `重发` at once, and `新对话` only confirms if `session.new` was actually sent.
  - M3-06: an auth timeout closes with 4408 instead of 4401, so no plugin forgets its token because of a slow first frame.
- **Left as is:** Slack `Retry-After` is not passed to the plugin's resend schedule; the plugin retries at 10 s / 30 s / 90 s regardless.
- **NOTE M3-07:** the phone-log test no longer claims to cover pairing codes (the relay pairing log guard covers them).

