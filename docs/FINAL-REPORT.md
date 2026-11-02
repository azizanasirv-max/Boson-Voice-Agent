# Final Engineering Report — Boson Higgs Realtime Latency & Microphone Reliability

Branch: `cline/dr98s15w` (from `main` @ `52d195d`). Baseline: `docs/BASELINE-REPORT.md`.

## 0. Two corrections to the task brief

1. **The stated VAD baseline does not match the code.** The brief says
   `silence_duration_ms: 650`; the committed code used **350**. 350 is what actually
   ran, so it is the real baseline and is preserved as the default.
2. **`create_response` / `interrupt_response` do not exist in this protocol.**
   The provider's AsyncAPI declares `TurnDetection` with
   `additionalProperties: false` and only `type`, `threshold`,
   `prefix_padding_ms`, `silence_duration_ms`, `min_speech_duration`. Sending the
   OpenAI-style keys would make `session.update` fail and **close the session**.
   They are now actively rejected (`buildTurnDetection` throws).
   The brief's instruction "do not introduce manual commits unless the provider
   protocol supports them" is satisfied: per the docs,
   *"Server VAD detected the end of user speech; a response follows automatically"*,
   so **no** per-turn `response.create` is sent, and none was added.

## 1. Confirmed root causes (with evidence)

| # | Root cause | Sev | Evidence |
| --- | --- | --- | --- |
| 1 | **Stale socket teardown.** `disconnect()` nulled `ws` before the close completed, and `onclose` unconditionally did `this.ws = null` + `stopMic()` + `setStatus('disconnected')`. A late close from a superseded socket killed the *new* session and the *active* microphone. | Critical | Reproduced against the original file: `after 1st open: connected / after reconnect: connected / after STALE close: disconnected`. New test asserts `connected` + mic alive. |
| 2 | **Hot microphone leak.** `MicCapture.start()` had no `try/catch` after `getUserMedia`; a worklet/AudioContext failure left the track live (mic indicator on) forever. | Critical | "Failure after getUserMedia stops the track". |
| 3 | **Silent suspension.** `new AudioContext()` runs after an `await` (token fetch), can start `suspended`, and `resume()`'s result was ignored — zero frames while the UI said "Streaming Live". | High | "Blocked AudioContext is reported as an error". |
| 4 | **No device-loss detection.** No `ended`/`mute` listeners, no frame watchdog: unplugging the mic left the UI claiming live audio. | High | "Track ended", "stalled", "no frames". |
| 5 | **Duplicate capture sessions.** `startMic` only guarded `'recording'`, so a rapid double click created two captures (2× upload). | High | "Rapid double startMic opens exactly one capture session". |
| 6 | **Microphone routed to `ctx.destination`** — side-tone into the salesperson's ears and the echo canceller. | High | Asserts a gain-0 sink. |
| 7 | **Fabricated latency metric.** `firstDeltaToFirstRenderMs` hardcoded `0`; "first visible text" was really "first delta received". | High | "First-render latency is measured, not hardcoded to zero". |
| 8 | **Server-crashing close code.** The proxy forwarded the client's close code verbatim; browsers report `1005` ("no status") and `ws.close(1005)` throws inside the close handler → **uncaught exception kills the Node process, dropping every other session**. | Critical | Found by the integration suite: the run crashed with `TypeError: First argument must be a valid error code number`. |
| 9 | **Audio-stream splicing on queue overflow.** The pre-open queue evicted `splice(1,1)` — a frame from the *middle* of the stream. | Med | "Overflow drop policy never splices the stream…". |
| 10 | **No heartbeat.** Neither leg pinged; a half-open socket stalled silently. | Med | Implemented, §4. |
| 11 | **Weak anti-aliasing.** One biquad gave ~18 dB rejection at 18 kHz → aliasing into ~6 kHz after 48k→24k. | Med | The test failed at 18 dB, passes at 4th order. |
| 12 | **Frontend churn.** `setMicLevel` 20×/s re-rendered the tree; every `recv` retained unbounded raw JSON. | Med | 10 Hz throttle; raw JSON capped at 2000 chars. |
| 13 | **Test-fidelity gap.** `test/test-proxy-and-timing.ts` re-implements the proxy inline, so it can never fail when `server.ts` regresses. | Med | New suite imports the real `attachRealtimeProxy`. |
| 14 | **Dead duplicate worklet** (`worklets/capture-processor.js`, 100 ms) contradicted the inline 50 ms worklet. | Low | Deleted; one source of truth. |

## 2. What I deliberately did NOT change

- **`silence_duration_ms` stays 350.** No real-provider session was available, so
  650/550/500 could not be compared fairly. `test/vad-ab.ts` now provides a fair A/B
  (same WAV, same pacing, only the silence window changes) and **skips with an
  explicit message** instead of inventing numbers.
- **`threshold` stays 0.5.** Not lowered (per brief) and not raised blindly either;
  now clamped and documented.
- **Frame size stays 50 ms.** 100 ms adds up to 100 ms of pure buffering before the
  provider can see end-of-speech; 20 ms triples per-frame overhead. Rationale is
  recorded at `MIC_FRAME_MS`.
- **Sales instructions untouched** — verified byte-identical by test.


## 3. Files modified

| File | Change |
| --- | --- |
| `src/audio/capture.ts` | Rewritten lifecycle: guaranteed teardown, muted sink, track listeners, first-frame + stall watchdogs, frame/RMS telemetry, `MicCaptureLike` seam, worklet source generated from `MIC_FRAME_MS`. |
| `src/audio/resample.ts` | 4th-order cascaded anti-alias filter (`createCascadeLowpass`). |
| `src/audio/worklets/capture-processor.js` | **Deleted** (dead, divergent 100 ms framing). |
| `src/realtime/RealtimeClient.ts` | Socket epoch guard, single-flight `startMic`, mic health stream, `markFirstRender`, `computeSlowestStage`, drop counter, bounded log retention, validated VAD passthrough, `getMicHealth`. |
| `src/realtime/events.ts` | `VadConfig`/`DEFAULT_VAD_CONFIG`, whitelist-validated `buildTurnDetection`, `min_speech_duration`, `responseCancel`, docs corrected (50 ms). |
| `src/realtime/types.ts` | `MicState` extended, new `MicHealth`, per-turn render/slowest-stage fields. |
| `src/realtime/diagnostics.ts` | Mic health block, measured render stage, `percentile` p50/p95, slowest-stage ranking, honest VAD caveat. |
| `src/components/MicControlBar.tsx` | Distinct denied/unavailable/disconnected/muted/no-audio states; meter gated on real frame flow. |
| `src/App.tsx` | Mic health state, 10 Hz level throttle, double-`rAF` paint reporting. |
| `server.ts` | `attachRealtimeProxy` exported, `perMessageDeflate: false`, heartbeat both legs, `selectDropIndex`, `sanitizeCloseCode`/`sanitizeCloseReason`, drop/forward counters. |
| `package.json` | `test`, `test:unit`, `test:audio`, `test:mic`, `test:client`, `test:config`, `test:proxy`, `test:vad-ab`. |
| `docs/` | `BASELINE-REPORT.md`, `MANUAL-TEST-PROCEDURE.md`, this report. |
| `test/` | `harness.ts` + 5 new suites + `vad-ab.ts`. |


## 4. Fix → verifying test map

| Fix | Verification |
| --- | --- |
| Socket epoch guard | "A stale socket close must not kill the new session or its microphone"; "A stale socket message is ignored" |
| Guaranteed mic teardown | "Failure after getUserMedia stops the track"; "Blocked AudioContext…"; "stop() releases tracks…" |
| Muted sink (no side-tone) | "Microphone is routed through a zero-gain sink, never to speakers" |
| Track loss / mute / unmute | "Track ended surfaces as disconnected state"; "System mute / unmute…" |
| Stall + first-frame watchdogs | "A stalled audio graph is detected…"; "A microphone that produces no frames is flagged…" |
| Single-flight `startMic` | "Rapid double startMic opens exactly one capture session" |
| Real first-render metric | "First-render latency is measured, not hardcoded to zero" |
| Close-code crash | "Client closing with no status code (1005) must not crash the proxy"; "Close codes and reasons are sanitised…" |
| Stream-safe drop policy | "Overflow drop policy never splices the stream or drops the session update" |
| Proxy correctness/latency | "Steady-state: …forwarded in order, without loss"; "Pre-open race…"; "Server events are relayed…" |
| 4th-order anti-alias | "Resampler: rejects out-of-band audio instead of letting it alias" |
| PCM16 correctness | "PCM16: little-endian byte order and symmetric clipping"; "…expected byte count" |
| VAD whitelist | "turn_detection contains only provider-whitelisted fields"; "Protocol-illegal … rejected, never sent" |
| p50/p95 + slowest stage | "Diagnostics report aggregates 20 turns into median and p95"; "computeSlowestStage names the dominant stage" |
| Instructions preserved | "Sales copilot instructions are preserved in full" |

## 5. Measurements actually obtained

| Measurement | Value | Condition |
| --- | --- | --- |
| Proxy forwarding overhead (browser→upstream) | **median 1.63–1.72 ms, max 2.31 ms** over 51 frames | loopback, real `attachRealtimeProxy`, fake upstream |
| Frame loss at steady state | **0 of 51** | same |
| Pre-open queue replay | 5/5 frames, original order | same |
| `tsc --noEmit` | 0 errors | |
| `vite build` | success, `index-*.js` 317.82 kB | |
| Automated tests | **48 pass / 0 fail** (41 new + 7 legacy); stage1 9 verified / 3 need a key / 0 failed | |

**Before/after, honestly scoped:** the numbers above are client/proxy/DSP
measurements taken under identical conditions, so those comparisons are valid.
**Provider-bound latency (speech-stop → first token) has no before/after number**,
because no `BOSON_API_KEY`, browser, or audio device exists in this environment.
Claiming an end-to-end latency improvement would be fabrication. What is true:
three defects that *provably* destroyed sessions or silently killed audio are
fixed, and the previously faked `firstDeltaToFirstRender` is now measured — so the
next real-world run will yield trustworthy p50/p95.

## 6. Test results by actual category

| Category | What actually ran | Result |
| --- | --- | --- |
| A. Static inspection | Full source read, git history, provider AsyncAPI/OpenAPI schemas | 14 defects confirmed |
| B. Unit tests | `audio-pipeline`, `session-config`, `realtime-client` | 24/24 pass |
| C. Integration tests | `proxy-integration` (real `attachRealtimeProxy` + fake upstream on loopback) | 8/8 pass |
| D. Synthetic audio tests | Sine/DC/clipping through the real resampler + PCM16; synthetic frames through the real worklet-port handler | pass |
| E. Actual provider connection | **NOT RUN** — no `BOSON_API_KEY`. `vad-ab.ts` and `diagnose-ws.ts` skip loudly. | unavailable |
| F. Real browser microphone | **NOT RUN** — no browser/audio device. Procedure: manual §1–3. | unavailable |
| G. Android/mobile browser | **NOT RUN** — procedure: manual §7. | unavailable |

A synthetic PCM test is not a microphone test. The handshake that passed here was
against a fake upstream, not Boson.

## 7. Remaining defects and limitations

1. **Unverified against the live provider** — nothing here proves Boson's
   endpointing, STT timing, or generation speed.
2. **VAD values are unvalidated by A/B.** 350 ms may still be too aggressive for
   some speakers; only a real 20-turn run can decide.
3. **No automatic reconnection.** Deliberate: `disconnect()` is now safe and the UI
   reports the failure, but a dropped session stays dropped until the user
   reconnects. Auto-reconnect risks duplicate sessions mid-turn.
4. **Perceived latency still includes the VAD window** (~350 ms) *before*
   `speech_stopped`, which is not client-measurable; it is documented in the
   diagnostics rather than silently omitted.
5. **`speechEndToFirstRenderMs` depends on the UI calling `markFirstRender`.** If
   the tab is throttled or a consumer never calls it, the metric is `N/A`, never a
   fake 0.
6. **One AudioContext per capture session** — created on start, closed on stop.
   Correct across repeated cycles, but not free (~10 ms).
7. **Heartbeat interval is 20 s**, so a half-open socket takes up to ~40 s to
   detect. Detection latency, not audio quality.
8. **`test/test-proxy-and-timing.ts` still tests its own inline copy** — kept for
   history, superseded by `proxy-integration.test.ts`.

## 8. Is the microphone pipeline verified end-to-end?

**No — and it would be dishonest to say otherwise.** Verified:
`getUserMedia` → AudioWorklet → resample → PCM16 → base64 → WebSocket → proxy →
upstream socket, using stubbed browser audio APIs and a fake upstream. Not
verified: acoustic capture, real device enumeration, real provider reception, real
permission UX.

## 9. Was real microphone testing performed?

**No.** No physical microphone, browser, or `BOSON_API_KEY` was available.
`docs/MANUAL-TEST-PROCEDURE.md` is the exact procedure to close that gap.

## 10. Is the application ready for production testing?

**Ready for supervised production testing — not for unattended production use.**
The failure modes that caused dead microphones and cross-session breakage are fixed
and regression-tested, and diagnostics now report the truth (frame flow, drops,
real render latency, slowest stage). Before shipping to salespeople, run §1–§5 of
the manual procedure with a real key and microphone, and only then consider VAD
changes based on §6.

## 11. How to reproduce everything

```bash
bun install
npm run lint           # tsc --noEmit
npm run build          # vite build
npm run test:unit      # 41 tests across 5 suites + legacy timing suite
npm run test:stage1    # requirement audit (3 items need a real key)
BOSON_API_KEY=... VAD_AB_WAV=/path/utterance-24k-mono.wav npm run test:vad-ab
```
