# Manual Test Procedure — Physical Microphone & Real-Provider Verification

Nothing in this repository's automated suites can prove acoustic capture, real
provider latency, or mobile-browser behaviour. Those require the steps below.
Run them in order; stop at the first failure.

## 0. Preconditions

- `BOSON_API_KEY` set in `.env` (server side only, never in `VITE_*`).
- `npm run dev` (or a production build behind HTTPS).
- A quiet room, a working microphone, and a second human who can talk.
- Keep the in-app diagnostics open: **Header → Diagnostics** and the debug drawer.

## 1. Microphone permission lifecycle

| Step | Expected |
| --- | --- |
| 1.1 Click **Start Customer Mic** and click **Block** in the permission prompt. | Chip reads **Permission denied**; banner shows an actionable message. No "Streaming Live". |
| 1.2 Reload, click Start, click **Allow**. | Chip reads **Streaming Live (24kHz PCM16)**, `frames` counter increases ~20/s, level meter moves with speech. |
| 1.3 Talk continuously and watch `frames`. | Counter advances steadily; no gaps. |
| 1.4 Mute the microphone from the OS. | Chip switches to **Microphone muted by system**. |
| 1.5 Unmute. | Chip returns to **Streaming Live** within ~1s. |
| 1.6 With the mic running, physically unplug a USB microphone (or revoke permission in the browser site settings). | Chip reads **Microphone disconnected**. Never keeps showing "Streaming Live". |
| 1.7 Replug / re-grant and press **Start Customer Mic** again. | Capture resumes; `frames` continues. |
| 1.8 Put the tab in the background for 30s, then return. | Frames resume (the visibility handler resumes a suspended AudioContext). If not, chip reports **Open, but no audio flowing**. |

Negative check for the old silent-failure mode: at no point should the UI show
"Streaming Live" while `frames` is not advancing.

## 2. Reconnect safety (the stale-socket defect)

| Step | Expected |
| --- | --- |
| 2.1 Connect + start mic, then press **Disconnect**. | Status disconnected, mic stops, browser mic indicator turns off. |
| 2.2 Immediately press **Connect** and **Start Customer Mic** (within ~1s). | Status stays connected; the chip stays **Streaming Live**. |
| 2.3 Speak for 30s. | Suggestions keep arriving. If the old socket's close event had clobbered the session, the UI would drop to disconnected and the mic indicator would go dark mid-sentence. |
| 2.4 Repeat 2.1–2.2 five times rapidly. | No duplicate mic indicator, no double upload (diagnostics `Audio Chunk Rate` stays ~20/s, not ~40/s). |

## 3. No feedback path

With speakers (not headphones) at moderate volume: start the mic and speak.
You must **not** hear your own voice echoed back, and the customer side of a real
call must not hear the AI or a delayed copy of the salesperson.

## 4. Latency measurement (20+ turns)

1. Open Diagnostics; note `Samples with a latency value`.
2. Have the second person speak **20 short utterances** (>1s, ending with a clear
   full stop, 3–5s apart).
3. Copy the full diagnostic report.
4. Confirm:
   - `Samples with a latency value: >= 20`
   - `Turns without input_audio_buffer.speech_stopped: 0`
   - Median and p95 `Speech-End-to-First-Text`
   - `Most frequent slowest stage`
   - `Microphone Frames Dropped (socket not writable): 0`
   - `First Delta → UI Render (measured)` is a real number, not a constant 0
5. Expected shape (not a guarantee): endpointing (~350 ms configured) +
   `speech-end→response-created` + `response-created→first-delta`. If the median
   first text lands within ~1s of the speaker stopping, the pipeline is healthy.
6. If p95 is much worse than the median, look at `Most frequent slowest stage`
   before changing any VAD value.

## 5. Utterance-integrity check (must precede any VAD change)

For every one of the 20 turns, read the transcript in the UI and confirm:
- no truncated final words,
- no split sentences turned into two turns,
- no duplicated turns.

Only if all 20 are clean may you consider lowering `silence_duration_ms`.

## 6. Fair VAD A/B (optional, only with a key and a real recording)

```bash
# 24 kHz, mono, 16-bit WAV of one natural utterance
export VAD_AB_WAV=/path/to/utterance-24k-mono.wav
export VAD_AB_VALUES=650,550,500
export VAD_AB_TURNS=20
npm run test:vad-ab
```

Choose the **lowest** value with zero failures and complete transcripts. Do not
change `threshold` or `prefix_padding_ms` in the same run.

## 7. Mobile / Android

| Step | Expected |
| --- | --- |
| 7.1 Open over **HTTPS** in Chrome on Android. | `getUserMedia` is unavailable on plain HTTP for non-localhost origins. |
| 7.2 Start mic, lock the screen for 10s, unlock. | Frames resume or the chip reports "no audio flowing". |
| 7.3 Switch to another app and back. | Same as 7.2. |
| 7.4 Accept an incoming call, then return. | Audio focus returns; if not, chip reports the error state instead of pretending. |

## 8. Sign-off checklist

- [ ] Mic permission denied / granted / unplugged / muted all report distinctly
- [ ] No "Streaming Live" without advancing frames
- [ ] Rapid disconnect→reconnect keeps the session and the mic alive
- [ ] No audible side-tone of the microphone
- [ ] >= 20 turns recorded, p50/p95 captured, slowest stage identified
- [ ] Transcripts complete (no fragmentation) at the chosen VAD value
- [ ] Android backgrounding handled without a silent dead microphone
