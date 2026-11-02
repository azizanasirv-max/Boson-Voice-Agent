# Boson Higgs Realtime — Baseline Report (Phase 1)

Recorded before any modification. Branch: `cline/dr98s15w` (created from `main` @ `52d195d`).

## 1. Repository state

| Item | Value |
| --- | --- |
| Branch at audit | `main`, clean working tree |
| Uncommitted user changes | **none** (nothing to preserve) |
| Commits | `e393a3b` Initial commit, `52d195d` feat: initialize Boson AI Higgs Realtime tester |
| Runtime | Node v24.15.0, bun 1.4.3, deps installed from committed `bun.lock` |

## 2. Actual pipeline (mic -> provider -> UI)

```
getUserMedia
  -> AudioContext (device default sample rate, typically 48000)
  -> AudioWorkletNode 'capture-processor'  (50 ms frames, Float32 mono)
  -> main thread: RMS + Butterworth LPF (cutoff 0.45 x 24000) + linear-interp resample -> 24000
  -> floatTo16BitPCM (Int16Array, little endian) -> base64
  -> JSON { type: input_audio_buffer.append, audio } over browser WebSocket /ws/realtime
  -> Express/ws proxy (server.ts) -> wss://api.boson.ai/v1/realtime?model=higgs-realtime
  -> server_vad -> input_audio_buffer.speech_started / speech_stopped
  -> (provider auto-creates response; docs: "a response follows automatically")
  -> response.created -> response.output_text.delta* -> response.done
  -> RealtimeClient.handleServerMessage -> onMessageDelta -> React setState -> ConversationView
```

Auth: `GET /api/token` mints an ephemeral secret (`bai-eph-...`); the browser passes it as
subprotocol `bai-client-secret.<key>`; the permanent key never leaves `server.ts`.

## 3. Recorded configuration (as found in code)

`src/realtime/events.ts` `buildSessionConfig()`:

```
output_modalities: ["text"]
audio.input.format: { type: "audio/pcm", rate: 24000 }
audio.input.turn_detection: { type: "server_vad", threshold: 0.5,
                              prefix_padding_ms: 300, silence_duration_ms: 350 }
audio.input.transcription: { model: "higgs-stt-3.1", language: "en" }
```

**Discrepancy:** the mission statement describes the baseline as `silence_duration_ms: 650`.
The code as committed is `350`. `350` is what actually runs and is the real baseline.
`min_speech_duration` (provider feature, default 0.125) is not set.

Provider defaults per official AsyncAPI (`docs.boson.ai/asyncapi.json`,
`components.schemas.TurnDetection`): `threshold` default **0.85**, `prefix_padding_ms`
default 300, `silence_duration_ms` default **500**, `min_speech_duration` default 0.125.
`turn_detection` is declared with `additionalProperties: false` — the OpenAI-style
`create_response` / `interrupt_response` keys **do not exist** and would make
`session.update` fail and close the session.

## 4. Test results (baseline)

| Suite | Result |
| --- | --- |
| `npx tsc --noEmit` (`npm run lint`) | PASS, exit 0 |
| `npx vite build` | PASS, 1674 modules, `index-*.js` 304.94 kB |
| `npx tsx test/run-tests.ts` (`test:stage1`) | 12 requirements: 9 VERIFIED, 3 UNTESTED (need key), 0 FAILED |
| `npx tsx test/test-proxy-and-timing.ts` | 7/7 PASS |
| `npx tsx test/diagnose-ws.ts` | aborts: "No BOSON_API_KEY found!" |
| `npx tsx test/test-keepalive.ts` | aborts: "No BOSON_API_KEY found!" |
| `npx tsx test/test-audio-streaming-120s.ts` | not run (needs key) |

Test-fidelity defects found in the baseline suite:

* `test/test-proxy-and-timing.ts` re-implements the proxy inline ("mirroring server.ts
  logic") instead of importing it. It therefore **cannot fail** when `server.ts` regresses.
* No test covers `MicCapture`, the microphone lifecycle, or `RealtimeClient`'s socket
  state machine.

## 5. Latency measurements available at baseline

**None that are trustworthy against the real provider** — no `BOSON_API_KEY`, no browser,
no audio device in this environment. What exists is in-app instrumentation:

* `speechEndToFirstVisibleTextMs` is measured from `input_audio_buffer.speech_stopped`
  to the **first `response.output_text.delta` arriving**, not to first paint.
* `firstDeltaToFirstRenderMs` is **hardcoded to `0`** — a fabricated value.
* `speechEndToCommittedMs`, `committedToTranscriptionMs`, `speechEndToResponseCreatedMs`,
  `responseCreatedToFirstDeltaMs` are measured (delta-receipt based).
* Per-turn history keeps the last 50 turns (`TurnTimingDiagnostic`), so a 20-turn
  p50/p95 sample is *collectable* once a key exists; no aggregation or p95 is computed.

## 6. What cannot be measured in this environment

1. Real provider turn latency (needs `BOSON_API_KEY`).
2. Real browser microphone path (no Chromium/mic in sandbox).
3. Android/mobile browser behaviour.
4. Real network RTT browser -> Express -> Boson.
