# kid-glasses

An Even Realities G2 plugin for Even Hub. The end goal is a voice "Kid panel": voice in → relay → Slack → Fox's assistant bot → text back on the lenses.

**M0 (this milestone) only probes what the device can do.** It has no Slack, Cloudflare, Deepgram or secrets of any kind.

| Page | What it probes |
|---|---|
| Menu (hello screen) | Layout with a status line (app · page · clock), a body and a gesture hint line |
| 1. Glyph test (CJK) | 480 common hanzi in rows with indices (`001`, `021`, …); punctuation `P01..P30`; full-/half-width pairs `W01..W31`; mixed CN/EN/digits `M01..M08`; rare chars and symbols `R01..R32`. Every sample sits in `[ ]`, so a dropped glyph shows as empty brackets |
| 2. Page capacity | Self-describing rulers for Chinese chars per line (十=10 廿=20 卅=30 卌=40), English chars per line (digit at every 10th position), a mixed paragraph, and numbered lines for lines per page (full-screen and body area) |
| 3. Mic capture | `audioControl` with hold-to-record (LONG_PRESS 9 / RELEASE 10) and a tap toggle as fallback; glasses or phone mic; live bytes, duration (16 kHz s16le mono), RMS bar plus dBFS; the last clip is kept in memory as `Int16Array` |
| 4. Background probe | 1 s heartbeat (ticks vs. wall-clock expected, largest gap) and a WebSocket echo ping every 5 s to `wss://echo.websocket.org`. Lifecycle events go into a 1000-entry localStorage ring buffer, which also counts reloads (`boot #n`) |

The phone screen (WebView) mirrors the current lens text in a monospace box and shows the log. Use it as the reference when you check which glyphs are missing on the lens.

## Prerequisites

- Node ≥ 20.17 (developed on Node 26) and npm.
- Even App **≥ 2.2.10**. SDK 0.0.16 declares `minAppVersion 2.2.10`, and long-press needs SDK ≥ 0.0.14.
- An Even Hub developer account. Logging in once at <https://hub.evenrealities.com/login> turns on the developer section in the phone app.
- `qrencode` (used for the PNG QR) and `zbarimg` (optional, to verify it).
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
- With `HTTP(S)_PROXY` set, the webview showed "Message was restarted too many times". Exempting localhost and the LAN IP with `NO_PROXY` fixes it.

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

A packaged `.ehpk` can only reach a phone by uploading it to the Even Hub portal as a Private build (portal → Builds, then on the phone Even Hub → Me → Apps → Private builds). **M0 does not upload anything.** Real-device testing uses the QR dev mode below.

## Sideload to iPhone + G2 (QR dev mode)

1. Get the desktop and the iPhone onto the same Wi-Fi, with no client isolation.
2. On the desktop, run `scripts/serve-lan.sh`. It:
   - builds the app;
   - starts `vite preview` on `0.0.0.0:5173` in the background (pid in `.dev/server.pid`, log in `.dev/server.log`);
   - writes the QR to `.dev/sideload-qr.png` and as ASCII to `.dev/sideload-qr.txt`, using the desktop's LAN IP.
   The device test serves the production build without HMR: a dev-server HMR socket that dies in the background would force a page reload and spoil the background probe.
3. Sign in once at <https://hub.evenrealities.com/login> with the same account as the phone app.
4. On the iPhone, force-quit the Even App by swiping it away in the app switcher, then reopen it.
5. Open the **Even Hub** tab. A developer section appears top-right. Tap **Scan QR** and scan the QR.
6. The plugin opens on the glasses. Double-tap on the menu brings up the system exit dialog.

If the phone shows "Couldn't connect", the desktop firewall is the first suspect. `ufw` is active on this machine; allow the port with `sudo ufw allow from <LAN-SUBNET> to any port 5173 proto tcp`.

To stop the server: `kill "$(cat .dev/server.pid)"`.

## Gestures

| Page | Swipe | Tap | Double-tap | Hold |
|---|---|---|---|---|
| Menu | move cursor | open | exit dialog | – |
| Glyph / Capacity | down = next, up = prev | – | back to menu | – |
| Mic | switch glasses ↔ phone mic (idle only) | start / stop | stop and back to menu | hold = record, release = stop |
| BG probe | – | WS reconnect | back to menu | clear log + reset heartbeat |

## Network whitelist

`app.json` asks for `g2-microphone`, `phone-microphone` and `network`. The network whitelist is exactly one entry, `wss://echo.websocket.org`: a public no-auth echo used only by the background probe. It sends a "Request served by …" greeting first, which the probe ignores, and then echoes every frame.

## Roadmap note: M1 relay

M1 will deploy the relay to **Cloudflare Workers + a Durable Object**, through claude-relay's already-authorized Cloudflare MCP (no `wrangler login`).

- **M0 deploys nothing to Cloudflare.**
- Secrets (Slack, STT and so on) are entered only by Fox, never committed. M0 has none.

## Real-device test plan

The checklist of numbers to report will be filled in after the first device run; see `docs/M0-REPORT.md`, written after Fox's test.
