# M0 report: G2 device-capability probes (draft)

Status: **draft.** Batch 1 of the real-device results is recorded here; the other items are placeholders until Fox runs them.

- Hardware: iPhone + Even Realities G2, Even App ≥ 2.2.10.
- Build: QR dev mode against <https://kid-glasses-m0.your-subdomain.workers.dev> (Worker `kid-glasses-m0`, Workers free tier, static assets plus a same-origin `/echo` WebSocket).
- SDK `@evenrealities/even_hub_sdk` 0.0.16.

## Device results

### Batch 1 (2026-11-25, build before the glasses-only mic change)

**Mic permission**

- Scanning the QR and recording showed **no iOS microphone permission prompt**.
- Fox's requirement from this batch: record from the **G2 glasses mic only, never the phone mic**. The build after batch 1 makes the glasses mic the only source (see "Mic source evidence").

**Background probe** (screenshot 08:13)

| Reading | Value |
|---|---|
| Heartbeat ticks / expected | 98 / 95, lost 0, max gap 1.0 s |
| WebSocket | open, pong 20 / 20, RTT 23 ms, 0 reconnects at the time of the shot |
| Boot | `boot #2`, up 1 m 35 s |
| Events / display writes | 52 events; 98 writes, 0 failures, 0 timeouts |
| Device | `conn=connected wear=false bat=97` |
| Launch source | `appMenu` |

Log around backgrounding:

```
08:12:09 b1 visibility=hidden
08:12:13 re-BOOT #2 (prevBoot#1 lastTick 5s ago)
         ws reconnect 98ms
```

What this shows:

- About 4–5 s after `visibility=hidden`, the WebView **reloaded the plugin** (`BOOT #2`). In-memory state did not survive the trip to the background; the localStorage ring log and boot counter did.
- After the reload the same-origin WebSocket came back in 98 ms.
- While in the foreground no heartbeat ticks were lost.

What is not known yet:

- Whether the reload is triggered by the phone app leaving the foreground or by the plugin page being hidden inside the Even App.
- What happens over a long background or with the phone locked.

**Pending from batch 1:** glyphs, capacity, recording, long background and lock screen.

### Batch 2 (pending)

| Item | What to report | Result |
|---|---|---|
| Mic: hold to record | lens `frames` / `bytes` / duration after 3–5 s hold; `audioControl open -> ?` | _pending_ |
| Mic: frame source | lens `ev src glasses N`, and whether any `PHONE` count appears (it must not) | _pending_ |
| Mic: direction tag | lens `dir …`: a number (glasses frame) or `null` | _pending_ |
| Mic: not worn | record with `wear false`; does `!! NO AUDIO FRAMES` appear within 3 s? | _pending_ |
| Mic: level | RMS / dBFS when silent vs. talking | _pending_ |
| Mic: iOS prompt | any iOS microphone prompt after this build (expected: none) | _pending_ |
| Glyphs | indices of hanzi rows with missing glyphs; empty `[ ]` in P / W / M / R samples | _pending_ |
| Capacity | ZH chars per line, EN chars per line (abc and xxx rulers), lines per page (full screen and body) | _pending_ |
| Long background | ticks vs. expected, lost ticks, max gap, boots, WS reconnects after 5 min and 30 min in background | _pending_ |
| Lock screen | the same readings after 5 min locked | _pending_ |

## Mic source evidence

Sources:

- The SDK 0.0.16 type definitions (`node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`).
- The SDK README.
- Official docs: <https://hub.evenrealities.com/docs/build/device-apis> and <https://hub.evenrealities.com/docs/reference/faq>.

**What `audioControl` does**

- The source is chosen on every call. `index.d.ts` declares `audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean>`, with `enum AudioInputSource { Glasses = "glasses", Phone = "phone" }`.
- device-apis: "Capture audio from the glasses four-mic array or the phone microphone."
- device-apis: "Pick the source on every `audioControl(true, ...)` call - default is glasses if you omit the second arg."
- device-apis, Glasses row: "Default. Requires `createStartUpPageContainer` to have run first."
- device-apis, Phone row: "No startup-page requirement; routes through the phone the WebView lives on."
- Permissions, per device-apis: "`g2-microphone` for `Glasses`, `phone-microphone` for `Phone`."

**What arrives in `audioEvent`**

- Each frame says which mic it came from. `AudioEvent` has `audioPcm: Uint8Array`, `source: AudioInputSource` and `direction: number | null`.
- SDK README: "Glasses `direction` is the raw signed int16 direction tag for the same processed PCM frame".
- SDK README: "Phone MIC and older Host payloads use `direction: null` and `AudioSpeakerRole.Unknown`."
- Format, per device-apis: "PCM 16 kHz, signed 16-bit little-endian, mono".

**Capture runs in the Even App, not the WebView**

- In the SDK's decoded string table (1135 strings) `audioControl` goes through `callEvenApp` to `flutter_inappwebview.callHandler`, passing `audioSource`.
- Neither the SDK bundle nor our built `dist/` contains `getUserMedia`, `mediaDevices`, `AudioContext` or `navigator`.
- Our source never touched the browser mic. Before this change it only ever called `audioControl(true, Glasses | Phone)`.

**Is the missing iOS prompt consistent with the glasses mic?**

Yes, but it does not prove the glasses mic was used:

- Glasses audio comes to the Even App over Bluetooth, so the plugin never opens the iPhone mic.
- A phone-mic request would also be served by the Even App's own native capture. If the Even App already holds iOS microphone access, iOS would not prompt again either.
- The docs do not say whether the phone OS permission is involved, or whether QR dev mode skips permission prompts.

How the next build decides it:

- It counts every frame's `source` and shows `ev src glasses N` on the lens. A `PHONE n` count would appear if any phone frame arrived.
- It also shows the last frame's `direction`.
- The simulator reports `source=glasses` with `direction=null`. On the real glasses a numeric `dir` would confirm processed glasses-mic frames.

**What changed after batch 1**

- Recording always uses `audioControl(true, AudioInputSource.Glasses)`.
- The swipe-to-switch-source option and the `phone-microphone` permission are gone.
- The mic page shows:
  - `src: glasses`;
  - frames, bytes and duration;
  - RMS bar and dBFS;
  - per-frame source and direction;
  - the `audioControl` return value;
  - device `conn` / `wear` / `bat` state.
- If no frame arrives within 3 s, the lens shows `!! NO AUDIO FRAMES Ns - check wear / connection`. If frames stop mid-recording, it shows `!! AUDIO STALLED`.

## Simulator results (evenhub-simulator 0.9.5, Linux)

- **Mic, glasses only:** the first frame arrives about 320 ms after `audioControl(true)`. Frames are 3200 B / 100 ms with `source=glasses`, `direction=null` and `speakerRole=unknown`.
  - Hold for 2.66 s: 25 frames, 80000 B, 2.50 s of audio.
  - `audioControl(false)` returns `false`.
  - About 3 frames still arrive after stop.
- **Background probe:** ticks match expected; the same-origin WS echo RTT is about 18 ms against the deployed Worker.
- **Capacity, in the simulator font** (the real lens font may differ):
  - ZH: 28 chars per line.
  - EN: 59 chars per line on the abc ruler, 52 on the xxx ruler.
  - Lines per page: 10 full screen, 8 in the body area.

Screenshots: `docs/screenshots/`.

## Open questions

- Is the reload about 4–5 s after `visibility=hidden` deterministic, and does a long background or lock screen kill the WebSocket or the heartbeat for good?
- Does the glasses mic deliver frames while `wear=false`?
- On real hardware, is `direction` non-null for glasses frames?
