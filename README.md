# kid-glasses

An Even Realities G2 plugin for Even Hub. The end goal is a voice "Kid panel": voice in → relay → Slack → Fox's assistant bot → text back on the lenses.

**M0 (this milestone) only probes what the device can do.** It has no Slack, Cloudflare, Deepgram or secrets of any kind.

| Page | What it probes |
|---|---|
| Menu (hello screen) | Layout with a status line (app · page · clock), a body and a gesture hint line |
| 1. Glyph test (CJK) | 480 common hanzi in rows with indices (`001`, `021`, …); punctuation `P01..P30`; full-/half-width pairs `W01..W31`; mixed CN/EN/digits `M01..M08`; rare chars and symbols `R01..R32`. Every sample sits in `[ ]`, so a dropped glyph shows as empty brackets |
| 2. Page capacity | Self-describing rulers for Chinese chars per line (十=10 廿=20 卅=30 卌=40), English chars per line (digit at every 10th position), a mixed paragraph, and numbered lines for lines per page (full-screen and body area) |
| 3. Mic capture | `audioControl(true, AudioInputSource.Glasses)` with hold-to-record (LONG_PRESS 9 / RELEASE 10) and a tap toggle as fallback. **Glasses mic only**: there is no phone-mic option and no `getUserMedia`. Shows `src: glasses`, frames, bytes, duration (16 kHz s16le mono), RMS bar plus dBFS, the per-frame `source` / `direction` after SDK normalisation (a missing source becomes `glasses`) plus the host's raw fields as `host: …`, the `audioControl` return value, and the device `conn` / `wear` / `bat` state. If no frame arrives within 3 s it shows `!! NO AUDIO FRAMES - check wear / connection` (or `AUDIO STALLED` if frames stop). The last clip is kept in memory as `Int16Array` |
| 4. Background probe | 1 s heartbeat (ticks vs. wall-clock expected, largest gap) and a WebSocket echo ping every 5 s to `wss://echo.websocket.org`. Lifecycle events go into a 1000-entry localStorage ring buffer, which also counts reloads (`boot #n`) |

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

The simulator screenshots in `docs/screenshots/` use the **simulator's** font. Glyph coverage and capacity numbers have to be re-read on the real lenses.

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
| Menu | move cursor | open | exit dialog | – |
| Glyph / Capacity | down = next, up = prev | – | back to menu | – |
| Mic | – | start / stop | stop and back to menu | hold = record, release = stop |
| BG probe | – | WS reconnect | back to menu | clear log + reset heartbeat |

## Network whitelist and CORS

`app.json` asks for `g2-microphone` and `network` only; `phone-microphone` was removed because the plugin records from the glasses mic only. The network whitelist holds exactly the deployed origin, in its two schemes:

- `https://kid-glasses-m0.your-subdomain.workers.dev`
- `wss://kid-glasses-m0.your-subdomain.workers.dev`

How the background probe picks its echo:

- When the page is served over https from a non-localhost origin, it uses the same-origin echo `wss://<origin>/echo`. The Worker sends a "kid-glasses echo ready" greeting, which the probe ignores, and then echoes every frame.
- When run locally (`npm run dev` plus the simulator), it falls back to the public echo `wss://echo.websocket.org`. That endpoint is not in the whitelist, because the packaged or hosted build never uses it.

All requests are same-origin. Static assets also carry `Access-Control-Allow-Origin: *` through `public/_headers`, and `index.html` is served with `Cache-Control: no-cache`, so a redeploy shows up on the next scan.

## Roadmap note: M1 relay

M1 will deploy the relay to **Cloudflare Workers + a Durable Object**, through claude-relay's already-authorized Cloudflare MCP (no `wrangler login`).

- **M0 deploys nothing to Cloudflare.**
- Secrets (Slack, STT and so on) are entered only by Fox, never committed. M0 has none.

## Real-device test plan

Batch 1 (background probe, mic prompt) is recorded in `docs/M0-REPORT.md` under "Device results". The batch-2 checklist of numbers to report (mic frames / source / direction / no-audio warning, glyphs, capacity, long background, lock screen) is the table in that section.
