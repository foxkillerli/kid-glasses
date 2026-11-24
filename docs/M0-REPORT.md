# M0 report: G2 device-capability probes

Status: **M0 closed on 2026-11-25.** Both device batches are done.

- Batch 1 (background probe) has exact numbers.
- Batch 2 (glyphs, capacity, recording, long background and lock screen) was signed off by Fox as "感觉都 ok". These items are marked **真机主观通过、未精确测量** (subjectively passed on the device, not measured precisely). Every capacity number used by the code therefore comes from the simulator.

## Summary

| Area | Result | Confidence |
|---|---|---|
| Display: layout, status / body / hint, rebuild and upgrade | Works; batch 1 had 98 writes, 0 failures, 0 timeouts | Measured (batch 1) |
| CJK glyphs | OK on the lens | 真机主观通过、未精确测量 |
| Text capacity | Simulator: ZH 28 per line, EN 52–59 per line, 8 body lines, 10 full-screen lines; the lens looked OK | Simulator measured; 真机主观通过、未精确测量 |
| Gestures: tap, double, swipe, long-press / release | Used throughout both batches | 真机主观通过 |
| Mic (glasses only) | Recording works | 真机主观通过、未精确测量; source not proven (see "Mic source") |
| Background: short | WebView reloads about 4–5 s after `visibility=hidden`; WS back in 98 ms; no lost ticks in foreground | Measured (batch 1) |
| Background: long, and lock screen | OK per Fox | 真机主观通过、未精确测量 |

- Hardware: iPhone + Even Realities G2. Even App version: not reported; the requirement is ≥ 2.2.10.
- Build: QR dev mode against <https://kid-glasses-m0.your-subdomain.workers.dev> (Worker `kid-glasses-m0`, Workers free tier, static assets plus a same-origin `/echo` WebSocket).
- SDK `@evenrealities/even_hub_sdk` 0.0.16.

## Device results

### Batch 1 (2026-11-25, build before the glasses-only mic change)

**Mic permission**

- After scanning the QR, **no iOS microphone permission prompt** appeared.
- Recording was still pending in batch 1. The app only opens a mic from `startRecording`, so no mic had been opened when this was observed. The missing prompt therefore says nothing about mic access yet. The real check is whether a prompt appears the **first time Fox records** (batch 2).
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

### Batch 2 (2026-11-25, glasses-only mic build)

Fox ran the remaining items and reported only "感觉都 ok", with no readings.

| Item | Result |
|---|---|
| Glyphs: Hanzi pages, punctuation, full/half width, mixed, rare | 真机主观通过、未精确测量. No missing-glyph indices were reported. |
| Capacity: ZH / EN chars per line, body and full-screen lines | 真机主观通过、未精确测量. The code uses the simulator values (see "Lens text capacity"). |
| Recording: hold and tap | 真机主观通过、未精确测量. Not reported: frame / byte counts, the `host:` line, `dir`, the iOS prompt at first record, the no-wear `NO AUDIO FRAMES` warning, and the physical check (phone mic covered). |
| Long background (minutes) and lock screen | 真机主观通过、未精确测量. Not reported: boot count, lost ticks, max gap, WS reconnects. |

## Lens text capacity

`LENS_TEXT` in `src/lib/lens-text.ts` is the one place the code takes these from. They are calibrated conservatively to the simulator.

| Field | Value | Basis |
|---|---|---|
| `zhCharsPerLine` | 28 | Simulator Cap ZH ruler. In the pretext font model 28 hanzi are 560 px against a 568 px inner width. |
| `enCharsPerLine` | 52 | The lower of the simulator's abc (59) and xxx (52) rulers |
| `bodyLines` | 8 | Simulator Lines body page (body box 224 px, 27 px per line) |
| `fullScreenLines` | 10 | Simulator Lines full page |
| `pageMaxBytes` | 900 | Margin under the 1000-byte create/rebuild limit |

How the wrapper counts and where it can go wrong:

- `wrapForLens` counts a wide char (CJK, fullwidth, kana, hangul, emoji) as 1/28 of a line and any other char as 1/52. Latin text breaks at spaces.
- Typical Chinese, English and mixed sentences wrap within the 568 px line in the pretext model. This is covered by `tests/lens-text.test.ts`.
- Known risk: capitals and digits are wider. In the pretext model 52 × `W` is 832 px and 52 digits are 584 px, so all-caps or long numbers can wrap on the lens earlier than counted, and a page can overflow its 8 lines. Pages built from Slack text should leave slack, or M1 should measure with pretext before going live.

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

**Capture is done by the Even App, not by browser APIs in the WebView**

- Our source never touches the browser mic. Before this change it only ever called `audioControl(true, Glasses | Phone)`.
- `rg` over `src/` and `index.html` finds no `getUserMedia` or `mediaDevices`.
- `grep` over the built `dist/assets/index-*.js` finds no `getUserMedia`, `mediaDevices`, `AudioContext` or `navigator.`. That bundle includes the SDK, but the SDK part is obfuscated, so for the SDK this grep alone proves little.
- I decoded the SDK's obfuscated string table: 1135 strings, none of them `getUserMedia`, `mediaDevices`, `AudioContext` or `navigator`.
  - The table does contain `audioControl`, `audioSource`, `callEvenApp`, `flutter_inappwebview` and `callHandler`.
  - **Inference, not traced:** `audioControl` is a native call into the Even App via the Flutter WebView bridge. I did not follow the control flow through the obfuscated code.

**How much the `source` label proves**

- In SDK 0.0.16, `normalizeAudioInputSource(undefined)` returns `glasses`, and so do `1` and `"xyz"`. `AudioEvent.fromJson({audioPcm:[0,0]})` gives `source=glasses`, `direction=null`, `speakerRole=unknown`. (Checked by running the SDK bundle in Node.)
- So `ev src glasses` only means "the host did not say phone"; a frame with no source field also counts as glasses.
- The simulator's host sends **no** source field: lens and log show `host: no source field`.
- The new build therefore also shows the host's raw fields (from `ev.jsonData`, minus the PCM) on the lens as `host: …`.
- `dir null` is inconclusive. Per the SDK README, phone-mic frames *and* older hosts send `null`.

**Is the missing iOS prompt consistent with the glasses mic?**

- Not yet testable: in batch 1 no mic had been opened (see above).
- If no prompt appears at the first recording, that is consistent with glasses capture. It is still not proof: phone-mic capture would also run inside the Even App, which may already hold iOS mic access.
  - **Inference:** glasses audio reaches the phone over the glasses link, not through the iPhone mic. The docs say "glasses four-mic array" but do not describe the transport.
- The docs do not say whether the phone OS permission is involved, or whether QR dev mode skips permission prompts.

How batch 2 decides it:

1. The `host:` line shows what the host actually sends.
2. A physical test: phone away or its mic covered, speak close to the glasses or tap the frame, and watch RMS.

**What changed after batch 1**

- Recording always uses `audioControl(true, AudioInputSource.Glasses)`.
- The swipe-to-switch-source option is gone.
- The `phone-microphone` permission is gone from `app.json`. `app.json` is not part of the hosted `dist/`, so this probably only matters for a packed `.ehpk`. Whether QR dev mode reads permissions at all is unverified.
- The mic page shows:
  - `src: glasses`;
  - frames, bytes and duration;
  - RMS bar and dBFS;
  - per-frame source and direction;
  - the host's raw fields;
  - the `audioControl` return value;
  - device `conn` / `wear` / `bat` state.
- If no frame arrives within 3 s, the lens shows `!! NO AUDIO FRAMES Ns - check wear / connection`. If frames stop mid-recording, it shows `!! AUDIO STALLED`. These lines are unit-tested only and have not been seen on a screen yet.

## Simulator results (evenhub-simulator 0.9.5, Linux)

- **Mic, glasses only:** the first frame arrives about 300–320 ms after `audioControl(true)`. Frames are 3200 B / 100 ms. The host sends no source field (`host: no source field`); the SDK fills in `source=glasses`, `direction=null` and `speakerRole=unknown`.
  - Hold for 2.66 s: 25 frames, 80000 B, 2.50 s of audio.
  - `audioControl(false)` returns `false`.
  - About 3 frames still arrive after stop.
- **Background probe:** ticks match expected; the same-origin WS echo RTT is about 18 ms against the deployed Worker.
- **Capacity, in the simulator font** (the real lens font may differ):
  - ZH: 28 chars per line.
  - EN: 59 chars per line on the abc ruler, 52 on the xxx ruler.
  - Lines per page: 10 full screen, 8 in the body area.

Screenshots: `docs/screenshots/`.

## Open risks

1. **Mic source is not proven.** `src=glasses` comes from the SDK's default for a missing field. Without the `host:` line from a real device and the physical check, a phone-mic path cannot be ruled out. The cheapest check is one recording with the phone mic covered, reading the `host:` line.
2. **The WebView reloads on background.** In batch 1, boot #2 came about 4–5 s after `visibility=hidden`. M1 must treat any background trip as a cold start:
   - keep session state on the relay;
   - reconnect quickly;
   - replay missed messages from history.
   Whether the lock screen or long backgrounds also reload or kill the socket was not measured.
3. **Capacity numbers come from the simulator.** All-caps text and digits can overflow (see above).
4. **Dev-mode permissions.** It is unknown whether QR dev mode enforces `app.json` permissions and the network whitelist. A packed `.ehpk` may behave differently, e.g. block an origin that is not whitelisted.
5. **`audioControl(false)` returns `false`** in the simulator and about 3 frames arrive after stop. M1 must ignore late frames after a stop.
6. **Git history was rewritten** by the dispatcher (filter-repo plus force-push) before batch 1. History now starts `9e8c0d7` → `0010ca1` → `82a3231`. SHAs quoted in earlier replies (for example `aa0ec38`) no longer exist.

## What M1 inherits

- **Display:** `DisplayQueue` (one write in flight; coalesced upgrades; 3 s timeout and redraw on `fgEnter` / visible) and the 4-box layout.
- **Text:**
  - `LENS_TEXT`, `wrapForLens` and `paginateForLens` to page Slack replies onto the lens.
  - `clampToLimit` to keep each write under the byte limits.
- **Input:** `classify` (zero-omitted click, sys vs text envelopes) and the gesture map:
  - hold = talk, release = send;
  - swipe = page;
  - double = back.
- **Audio:** glasses-only `audioControl(true, Glasses)`, `PcmAccumulator` (16 kHz s16le mono, about 3200 B per 100 ms) and the no-frames / stalled watchdog. These feed the relay's Deepgram stream.
- **Networking:**
  - `WsProbe`-style reconnect (3 s) with id-matched pings.
  - The whitelist must gain the relay origin (`https://` and `wss://`) once it is deployed.
- **Lifecycle:** the localStorage ring log and boot counter, kept as a field diagnostic.
- **Relay design** (scaffold in `relay/`, not deployed): Cloudflare Worker + Durable Object, Slack DM loop with Fox's user token restricted to the Kid DM channel, Deepgram streaming, and a fast-answer lane that is off by default. Fox's steps are in `docs/M1-FOX-SETUP.md`.

## Open questions

- Is the reload after `visibility=hidden` deterministic, and what do long backgrounds and the lock screen do to the socket and heartbeat (numbers, not impressions)?
- Does the glasses mic deliver frames while `wear=false`?
- On real hardware, does the host send a source field, and is `direction` non-null for glasses frames?
- Which Slack workspace is Kid in? This blocks M1 setup.
