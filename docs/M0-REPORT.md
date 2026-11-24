# M0 report: G2 device-capability probes (draft)

Status: **draft.** Batch 1 of the real-device results is recorded here; the other items are placeholders until Fox runs them.

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

**Pending from batch 1:** glyphs, capacity, recording, long background and lock screen.

### Batch 2 (pending)

| Item | What to report | Result |
|---|---|---|
| Mic: hold to record | lens `frames` / `bytes` / duration after 3–5 s hold; `audioControl open -> ?` | _pending_ |
| Mic: host fields | lens `host: …` line: does the host send a source field (`source=` / `audioSource=`), and what value? `no source field` means the `glasses` label is only the SDK default | _pending_ |
| Mic: physical check | phone in another room (or its mic covered), speak close to the glasses or tap the frame: does RMS jump? | _pending_ |
| Mic: frame source | lens `ev src glasses N`, and whether any `PHONE` count appears (it must not). This is the SDK-normalised label, so read it together with the `host:` line | _pending_ |
| Mic: direction tag | lens `dir …`: a number points to a processed glasses frame; `null` is inconclusive (phone mic and older hosts both send null) | _pending_ |
| Mic: not worn | record with `wear false`; does `!! NO AUDIO FRAMES` appear within 3 s? (this line has only been unit-tested; the simulator always sends frames) | _pending_ |
| Mic: level | RMS / dBFS when silent vs. talking | _pending_ |
| Mic: iOS prompt | any iOS microphone prompt at the **first** recording | _pending_ |
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

## Open questions

- Is the reload about 4–5 s after `visibility=hidden` deterministic, and does a long background or lock screen kill the WebSocket or the heartbeat for good?
- Does the glasses mic deliver frames while `wear=false`?
- On real hardware, is `direction` non-null for glasses frames?
