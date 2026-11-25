# M2 plan: Deepgram streaming STT

Written 2026-11-25. M2 makes the voice path (glasses mic → plugin → relay → Deepgram → Slack) production quality. M3 is out of scope.

## Goal

- Real-time Deepgram streaming through the relay.
- Live partial transcript on the lens as you speak, replaced by the final text.
- Mandarin, English and mixed speech.
- A dropped Deepgram socket or a slow final does not lose the turn or block later turns.

## Audit of the M1 path (before M2)

M1 path: the plugin sends `audio.start` and then raw PCM frames; the relay opens one Deepgram WebSocket per turn (`relay/src/hub-core.ts` `startAsr`), forwards frames, sends `CloseStream` on `audio.stop`, and posts the `is_final` text when Deepgram closes with 1000.

Gaps found:

1. **No timeouts.** If the Deepgram upgrade hangs, the turn stays "recording". If Deepgram never closes after `CloseStream`, the turn never resolves. Every later voice turn waits behind it in `turnChain`, so nothing more is posted until the Durable Object restarts.
2. **No KeepAlive.** Deepgram closes after 10 s without audio or KeepAlive (`NET-0001`). A stall in the phone's Bluetooth audio, or a slow connect, ends the turn as `asr-interrupted`.
3. **No Finalize.** The relay waits for the socket close, which adds latency after release.
4. **No retry.** A Deepgram connect failure or mid-stream close loses the whole turn. Audio is not kept.
5. **One language setting for every turn**, from `DEEPGRAM_LANGUAGE` only. No way to force Mandarin or English.
6. **No relay-side length cap.** Only the plugin stops at 60 s, and the plugin shows no message when it does.
7. **Owner socket gone mid-turn.** The relay cancels only when no device at all is connected.
8. **Last words.** The plugin stops forwarding frames the moment you release. M0 (simulator) saw about 3 frames (≈300 ms) still arrive after the mic is closed. Those frames were dropped.
9. **Metrics.** The only log line was `asr final len=N`. No latency, byte or close-code numbers.
10. **Spacing.** `joinSegments` handled CJK spacing between segments, but not inside one Deepgram transcript.

What was already right: `linear16`, 16 kHz, mono matches the SDK format ("PCM 16 kHz, signed 16-bit little-endian, mono", M0 report), frames of 3200 B per 100 ms in the simulator; `interim_results`, `punctuate`, `smart_format` on; one active turn per relay; `asr-empty` when nothing was recognised; `asr-interrupted` when the device socket drops.

## Deepgram config chosen

Sources read on 2026-11-25: Deepgram docs pages `multilingual-code-switching`, `changelog/2026/10/23`, `models-languages-overview`, `nova-3-language-prompting`, `understand-endpointing-interim-results`, `utterance-end`, `finalize`, `audio-keep-alive`, `close-stream`.

- **Default (`自动`): `model=nova-3`, `language=multi`, `language_hint=zh`, `language_hint=en`, `endpointing=100`.**
  - Since the 2026-10-23 changelog, `language=multi` serves a 55-language Nova-3 model, and its table lists Mandarin Simplified (`zh`, `zh-CN`, `zh-Hans`). The older 10-language model did not include Mandarin.
  - `language_hint` "biases detection; it doesn't restrict it", only applies with `language=multi`, and is fixed for the life of a streaming connection. Hinting `zh` and `en` matches user's speech.
  - Deepgram recommends `endpointing=100` for code-switching.
  - M1's device test passed on `nova-3` + `multi` (without hints), so this is the known-good base.
- **`中文`: `model=nova-3`, `language=zh-CN`, `endpointing=300`.** Monolingual Mandarin, for when mixed mode mishears Chinese.
- **`English`: `model=nova-3`, `language=en`, `endpointing=300`.**
- All modes: `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, `punctuate=true`, `smart_format=true`.
- **`utterance_end_ms` is not set.** Push-to-talk ends on an explicit release, and the relay finalizes then. `UtteranceEnd` messages are parsed and ignored.
- **Fallback.** If Deepgram rejects the upgrade with HTTP 400 (for example a hint it does not accept), the relay retries once with the M1 URL (`nova-3`, `multi`, no hints) and logs `fallback=1`.
- **Configurable** through plain vars: `DEEPGRAM_MODEL` (default `nova-3`), `DEEPGRAM_LANGUAGE` (default `multi`, used for `自动`), `DEEPGRAM_LANGUAGE_HINTS` (default `zh,en`; only used with `multi`).
- **Cost.** All three are pay-as-you-go streaming, billed per minute against the free credit. No plan, add-on or card is needed. A web search summary of deepgram.com/pricing gave Nova-3 multilingual streaming at $0.0058/min (promotional); 未核实 against the live page.

## Scope implemented

Relay (`relay/src/asr-turn.ts`, new; `deepgram.ts`; `hub-core.ts`; `hub.ts`):

1. **Per-turn language.** `audio.start` takes an optional `lang` (`auto` / `zh` / `en`). Missing means `auto`, so an old plugin keeps working.
2. **Connect** with a 5 s timeout. HTTP 401/402/403 → `asr-rejected` (no retry). HTTP 400 → one fallback to the M1 URL. Timeout, 429, 5xx or network error → retry.
3. **KeepAlive** (text frame) when no audio has gone to Deepgram for 3 s.
4. **Stop:** send `Finalize`, post as soon as the `from_finalize` result arrives, then `CloseStream`. If no `from_finalize` comes within 1.5 s, send `CloseStream` and post on the close. If neither arrives within 5 s of the stop, post what the lens showed (finals plus the last interim) and log `reason=timeout`.
5. **Retry within the turn.** The relay keeps the audio that Deepgram has not finalized yet (up to 15 s), using each final's `start + duration`. If the Deepgram socket drops, it reconnects and replays only that audio, with a time offset, so no segment is repeated. Up to 2 reconnects per turn. If the buffer overflowed or retries run out → `asr-interrupted`.
6. **Watchdogs.** No audio from the glasses for 10 s while talking → `asr-no-audio`. Over 62 s of audio → the relay stops the turn and posts it (the plugin stops at 60 s first). The owner socket closing mid-talk cancels the turn.
7. **Spacing.** Whitespace between two CJK characters is removed inside and between segments.
8. **Metrics, no content.** One line per turn: `asr done reason=… lang=… bytes=… frames=… audioMs=… firstPartialMs=… finalMs=… retries=… fallback=… close=… len=…`. Retry and connect lines carry only status codes, error names and counts.

Plugin (`src/app.ts`, `src/lib/relay-client.ts`):

1. **Language toggle** in the menu: `语言：自动（中英）` → `中文` → `English`. Stored in the phone's local storage, sent with each `audio.start`, shown in the Kid status line when it is not `自动`.
2. **Tail frames.** After you release, frames keep going to the relay until the mic close returns plus 250 ms, then `audio.stop`.
3. **Lens.** Live `你说：…` while talking (fill-triggered paging from M1), hint `… 正在转写` after release until the line becomes `我：…`. The error flash is cleared when you start talking again. At 60 s the lens says `说满 60 秒，已自动发送`.
4. **New error texts:** `asr-rejected`, `asr-no-audio`.

## Limits

- One voice turn at a time across all of user's glasses (`asr-busy`).
- A turn is at most 60 s on the plugin (62 s on the relay).
- Retry covers a Deepgram drop. It does not cover the glasses or phone dropping the relay socket: that turn is cancelled and the lens says `语音中断，这句没发出去`.
- Retry needs the unfinalized audio to fit in 15 s. A drop during a long sentence with no pause may not be recoverable.
- Traditional Chinese is not in the `multi` table; `zh-CN` returns Simplified.
- Not verified end to end against real Deepgram from the desktop: there is no device token or Deepgram key on the desktop. The real-device test (`docs/M2-DEVICE-TEST.md`) covers it.

## Review

- Codex (gpt-6.2-sol, critical-review, change `m2-deepgram-turn`, round 1): PASS, 0 BLOCK, 6 FIX_NEXT.
- Fixed before the first deploy:
  - M2-1: a reconnect re-checks the buffer before replaying, so audio trimmed while waiting is a reported drop, never a gap.
  - M2-2: the plugin sends `audio.stop` at most 1 s after release even if the mic close never answers, and a diagnostic recording cannot feed a tailing voice turn.
  - M2-3: a hung Deepgram upgrade is aborted on timeout or cancel, and `start()` no longer waits for it.
  - M2-4: a close before `CloseStream` is retried; an interim is posted only at the 5 s deadline.
  - M2-5: `asr.partial` / `asr.final` carry the turn `cid`, and the plugin ignores another turn's transcript.
- Round 2 (change `m2-deepgram-fixnext`): PASS, 0 BLOCK, 5 FIX_NEXT, all fixed before deploy:
  - the retry buffer keeps the unfinalized tail of a partly finalized frame;
  - a stopped turn posts only confirmed (`is_final`) text, except at the 5 s deadline;
  - a 1000 close after `Finalize` with every byte finalized posts, instead of retrying;
  - the plugin only shows transcripts whose `cid` is the live turn;
  - a late mic-open result cannot cancel a newer turn.
  - A third review round was not run.
- Left for later (from M1): M2-6, a Slack post that never returns blocks later voice turns. `chat.postMessage` has no deadline.

