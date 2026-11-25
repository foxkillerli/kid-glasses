# kid-glasses

An Even Realities G2 plugin for Even Hub. The end goal is a voice "Kid panel": voice in → relay → Slack → Fox's assistant bot → text back on the lenses.

**M0 (this milestone) only probes what the device can do.** It has no Slack, Deepgram or secrets of any kind. Its only Cloudflare use is static hosting of the test build plus a WebSocket echo (see below). The M1 relay lives in `relay/`. It is deployed at <https://kid-glasses-relay.your-subdomain.workers.dev> with no secrets yet.

| Page | What it probes |
|---|---|
| Menu (hello screen) | Layout with a status line (app · page · clock), a body and a gesture hint line |
| 1. Glyph test (CJK) | 480 common hanzi in rows with indices (`001`, `021`, …); punctuation `P01..P30`; full-/half-width pairs `W01..W31`; mixed CN/EN/digits `M01..M08`; rare chars and symbols `R01..R32`. Every sample sits in `[ ]`, so a dropped glyph shows as empty brackets |
| 2. Page capacity | Self-describing rulers for Chinese chars per line (十=10 廿=20 卅=30 卌=40), English chars per line (digit at every 10th position), a mixed paragraph, and numbered lines for lines per page (full-screen and body area) |
| 3. Mic capture | `audioControl(true, AudioInputSource.Glasses)` with hold-to-record (LONG_PRESS 9 / RELEASE 10) and a tap toggle as fallback. **Glasses mic only**: there is no phone-mic option and no `getUserMedia`. Shows `src: glasses`, frames, bytes, duration (16 kHz s16le mono), RMS bar plus dBFS, the per-frame `source` / `direction` after SDK normalisation (a missing source becomes `glasses`) plus the host's raw fields as `host: …`, the `audioControl` return value, and the device `conn` / `wear` / `bat` state. If no frame arrives within 3 s it shows `!! NO AUDIO FRAMES - check wear / connection` (or `AUDIO STALLED` if frames stop). The last clip is kept in memory as `Int16Array` |
| 4. Background probe | 1 s heartbeat (ticks vs. wall-clock expected, largest gap) and a WebSocket echo ping every 5 s to the same-origin `wss://<host>/echo` on the hosted build (local dev falls back to `wss://echo.websocket.org`). Lifecycle events go into a 1000-entry localStorage ring buffer, which also counts reloads (`boot #n`) |

The phone screen (WebView) mirrors the current lens text in a monospace box and shows the log. Use it as the reference when you check which glyphs are missing on the lens.

## Prerequisites

- Node ≥ 20.17 (developed on Node 26) and npm.
- Even App **≥ 2.2.10**. SDK 0.0.16 declares `minAppVersion 2.2.10`, and long-press needs SDK ≥ 0.0.14.
- An Even Hub developer account. Logging in once at <https://hub.evenrealities.com/login> turns on the developer section in the phone app.
- `qrencode` (used for the PNG QR) and `zbarimg` (optional, to verify it).
- Device testing needs no local server or open port: the test build lives on Cloudflare (see below).
- The SDK, CLI (`evenhub`) and simulator are pinned devDependencies, so nothing is installed globally.

```bash
npm install
```

## Run in the simulator

```bash
npm run dev
WEBKIT_DISABLE_DMABUF_RENDERER=1 NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1 \
  npx evenhub-simulator http://localhost:5173 --automation-port 9898
```

Two Linux quirks showed up on this machine:

- Under Wayland, WebKitGTK crashed with `Gdk Error 71`. `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes it.
- With `HTTP(S)_PROXY` set, the webview showed "Message was restarted too many times" for localhost. Exempting localhost with `NO_PROXY` fixes it.

`scripts/sim.sh` drives the simulator's automation API:

```bash
scripts/sim.sh input down click long_press long_press_release double_click
scripts/sim.sh shot my-shot
scripts/sim.sh console
```

`shot` writes `docs/screenshots/my-shot.png`, composited on black.

The simulator screenshots in `docs/screenshots/` use the **simulator's** font.

## Lens text capacity

`src/lib/lens-text.ts` has the single config constant `LENS_TEXT`, which all pagination uses:

| Field | Value | Source |
|---|---|---|
| `zhCharsPerLine` | 28 | Simulator, Cap ZH ruler |
| `enCharsPerLine` | 52 | Simulator, the lower of the two EN rulers (abc 59, xxx 52) |
| `bodyLines` | 8 | Simulator, Lines body page |
| `fullScreenLines` | 10 | Simulator, Lines full page |
| `pageMaxBytes` | 900 | Margin under the 1000-byte create/rebuild limit |

- Fox checked these on the real lenses and judged them OK, but did not measure them precisely.
- `wrapForLens` counts a wide char (CJK, fullwidth, kana, hangul, emoji) as 1/28 of a line and any other char as 1/52.
- `paginateForLens` splits text into pages of `bodyLines` lines.
- Known risk: runs of capitals or digits are wider than `x` in the font. In the pretext model, 52 × `W` is 832 px against a 568 px line, so all-caps text can wrap on the lens earlier than the counter predicts.

## Build / package

```bash
npm run typecheck
npm test
npm run build
npm run pack
```

`npm run pack` runs `evenhub pack app.json dist --sdk-ver 0.0.16` and writes `kid-glasses.ehpk`, which is gitignored.

A packaged `.ehpk` can only reach a phone by uploading it to the Even Hub portal as a Private build (portal → Builds, then on the phone Even Hub → Me → Apps → Private builds). **M0 does not upload anything.** Real-device testing uses the QR dev mode against the Cloudflare-hosted build below.

## Sideload to iPhone + G2 (QR dev mode, Cloudflare-hosted)

The test build is hosted on Cloudflare at **<https://kid-glasses-m0.your-subdomain.workers.dev>**:

- Worker `kid-glasses-m0` on the Workers free tier.
- The built `dist/` is served as Workers static assets.
- `worker/echo-worker.js` adds a same-origin WebSocket echo at `/echo`.
- No bindings, no secrets, no custom domain.

Nothing is served from the desktop, and the phone needs no particular Wi-Fi; any internet connection works.

QR files:

- `docs/sideload-qr.png` is the QR image.
- `docs/sideload-qr.txt` is the `evenhub qr` ASCII output.
- Both encode the bare URL `https://kid-glasses-m0.your-subdomain.workers.dev`. `evenhub qr --url … --json` reports exactly that URL, and both files decode to it with `zbarimg`.

Steps for Fox:

1. Check the phone app: **Even App ≥ 2.2.10**.
2. Sign in once at <https://hub.evenrealities.com/login> with the same account as the phone app. This turns the account into a developer account.
3. Force-quit the Even App by swiping it away in the app switcher, then reopen it.
4. Open the **Even Hub** tab. A developer section appears top-right. Tap **Scan QR** and scan `docs/sideload-qr.png`.
5. The plugin opens on the glasses. Double-tap on the menu brings up the system exit dialog.
6. The phone screen mirrors the lens text and shows the probe log:
   - If gestures seem dead, check "events seen / last gesture" there.
   - For the background test, the phone log is the authoritative record.

### Redeploying (Cloudflare MCP, no wrangler login)

1. Build and hash the assets:
   - Run `npm run build`.
   - Run `node scripts/cf-manifest.mjs dist`. Leave `/_headers` out of the manifest; it goes into `assets.config._headers` instead.
2. Through the Cloudflare MCP, call `POST /accounts/{id}/workers/scripts/kid-glasses-m0/assets-upload-session` with that manifest. It returns a one-hour upload JWT and the buckets.
3. Save the JWT to a file under `$TMPDIR`, then run `CF_ACCOUNT_ID=… scripts/cf-upload-assets.sh <jwt-file> <hash>=dist/<path> …`. The last upload prints the completion JWT.
4. Through the Cloudflare MCP, `PUT /accounts/{id}/workers/scripts/kid-glasses-m0` with:
   - a multipart body holding `worker/echo-worker.js` as the main module;
   - `bindings: []`;
   - `assets.jwt` set to the completion JWT;
   - `assets.config._headers` set to the contents of `public/_headers`.
5. Verify:
   - `curl` the page and the hashed JS, then compare the JS sha256 against `dist/`.
   - Open a WebSocket to `/echo`.

The upload JWT is a short-lived per-upload token, not an account credential. Never commit it.

## Gestures

| Page | Swipe | Tap | Double-tap | Hold |
|---|---|---|---|---|
| Kid (start page) | down = newer page, up = older | start / stop talking; while pairing: new code | menu | hold = talk, release = send |
| Menu | move cursor | open | exit dialog | – |
| Glyph / Capacity | down = next, up = prev | – | back to menu | – |
| Mic | – | start / stop | stop and back to menu | hold = record, release = stop |
| BG probe | – | WS reconnect | back to menu | clear log + reset heartbeat |

## Network whitelist and CORS

`app.json` asks for `g2-microphone` and `network` only; `phone-microphone` was removed because the plugin records from the glasses mic only. The network whitelist holds the plugin's own origin and the relay, each in two schemes:

- `https://kid-glasses-m0.your-subdomain.workers.dev`
- `wss://kid-glasses-m0.your-subdomain.workers.dev`
- `https://kid-glasses-relay.your-subdomain.workers.dev`: pairing (`/pair/start`, `/pair/poll`)
- `wss://kid-glasses-relay.your-subdomain.workers.dev`: `/device`, for messages and speech

How the background probe picks its echo:

- When the page is served over https from a non-localhost origin, it uses the same-origin echo `wss://<origin>/echo`. The Worker sends a "kid-glasses echo ready" greeting, which the probe ignores, and then echoes every frame.
- When run locally (`npm run dev` plus the simulator), it falls back to the public echo `wss://echo.websocket.org`. That endpoint is not in the whitelist, because the packaged or hosted build never uses it.

All requests are same-origin. Static assets also carry `Access-Control-Allow-Origin: *` through `public/_headers`, and `index.html` is served with `Cache-Control: no-cache`, so a redeploy shows up on the next scan.

## M1: talking to Kid

The plugin opens on the **Kid** page.

**Pairing.** On first start it has no device token. It gets a 6-digit code from the relay and shows it on the lens. Fox types `配对 <code>` in his Slack DM with Kid. The plugin then receives its own token and stores it in the SDK's local storage. No token is ever typed into the plugin or built into the bundle. Details are in [`relay/README.md`](relay/README.md#device-pairing).

**Talking.** Hold to talk and release to send, or tap to start and tap again to send.

- Audio comes from the G2 glasses mic only, through the same `checkFrameSource` gate as M0.
- It streams to the relay (Deepgram); the transcript is posted to Slack as `〔眼镜〕…` and Kid's webhook is called.
- The live transcript shows as `你说：…` while you talk. After release the plugin keeps forwarding frames for the mic close plus 250 ms, then sends `audio.stop`, so the last words are not cut off.
- **Language** (M2): the menu's second item cycles `自动（中英）` → `中文` → `English`. The choice is stored on the phone and sent with every `audio.start`. Config and limits: [`docs/M2-PLAN.md`](docs/M2-PLAN.md); device test: [`docs/M2-DEVICE-TEST.md`](docs/M2-DEVICE-TEST.md).
- Kid's replies appear on the lens, paginated with `LENS_TEXT`.

**Paging** (`src/lib/conversation.ts`). Pages flip when they fill, never on a timer.

- Growing content (the live transcript `你说：…` in the body while you talk, and each new message) keeps the view on the page that holds the newest text, so it advances the moment the current page fills.
- After you swipe back to an older page, re-layout and redraws leave you there. New content (a new transcript chunk or a new message) brings you back to the newest page, and fill-triggered advance resumes. The relay echoing a turn already shown as `我（待发）` does not count as new.
- A new Kid reply is revealed progressively at `READING_SPEED` (6 CJK / 15 Latin chars per second), and the page flips the moment it fills, then writing continues. This is on: `PROGRESSIVE_KID_REVEAL = true` in `src/lib/kid-reveal.ts`, a one-line switch. Set it to `false` and a reply shows in full from its first page.
- A tap or swipe during the reveal shows the rest at once; a swipe also moves one page. New content ends the reveal and goes to the newest page. Replayed (catch-up) and history replies are shown in full, without a reveal.

**Connection** (`src/lib/relay-client.ts`):

- First frame `auth`, then `hello {lastSeq}` and one history page.
- `ping` every 25 s; reconnect after 70 s without any frame.
- Exponential backoff with jitter (1–30 s). Reconnects immediately on visible / pageshow / online / foreground.
- `lastSeq` and unacknowledged typed turns persist across the background reload.
- Typed turns are resent with the same `cid` and the relay dedupes them.

The plugin is still served from `kid-glasses-m0`, so the QR code is unchanged. The relay is Worker `kid-glasses-relay`, with a SQLite Durable Object `RelayHub`. Secrets are entered only by Fox ([`docs/M1-FOX-SETUP.md`](docs/M1-FOX-SETUP.md)). Fox's device test is [`docs/M1-DEVICE-TEST.md`](docs/M1-DEVICE-TEST.md).

## Real-device test plan

Run on iPhone + G2 through QR dev mode against the hosted build. Record the results in `docs/M0-REPORT.md`, "Device results".

**Setup**

- [ ] Note the Even App version and the glasses battery level.
- [ ] Close the plugin completely, reopen it, and confirm the build: on the mic page the hint reads `hold: rec  tap: toggle  2tap: menu`.

**Glyphs (page 1)**

- [ ] Swipe through every Hanzi page. Note the index (`001`, `021`, …) of any row with a missing or garbled glyph.
- [ ] On the Punct / Full-half / Mixed / Rare pages, note every sample id whose brackets are empty (`P07[]`) or show a box.

**Capacity (page 2)**

- [ ] Cap ZH: the last ruler mark (十 / 廿 / 卅) visible on the first line, which gives Chinese chars per line. The simulator shows 28.
- [ ] Cap EN: the last digit visible on the abc and xxx rulers. The simulator shows 59 and 52.
- [ ] Lines full and Lines body: the last line number visible. The simulator shows 10 and 8.

**Mic (page 3), glasses only**

- [ ] Hold 3–5 s, then release. Note `frames`, `bytes`, duration, `audioControl open -> …`, `ev src … dir …` and the full `host: …` line.
- [ ] Note whether an iOS microphone prompt appears at the first recording.
- [ ] Tap to start, tap to stop: the same readings.
- [ ] RMS silent vs. talking.
- [ ] Physical check: with the phone in another room or its mic covered, speak near the glasses or tap the frame. Does RMS jump?
- [ ] Take the glasses off (`wear false`) and record. Does `!! NO AUDIO FRAMES` appear within 3 s?

**Background (page 4)**

- [ ] Foreground for 2 min: ticks vs. expected, lost, max gap, WS pong count.
- [ ] Switch to another app for 30 s, 5 min and 30 min, then return. Note `boot #`, ticks / lost / max gap, WS reconnects, and the log lines around `visibility=hidden`.
- [ ] Lock the phone for 5 min with the plugin open, unlock, and note the same readings.
