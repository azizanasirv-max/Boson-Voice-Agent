/**
 * VAD endpointing A/B harness.
 *
 * Compares silence_duration_ms values fairly on a REAL provider session:
 * same speech file, same pacing, same everything else. Only the silence window
 * changes, so a difference is attributable to it.
 *
 * Requirements (it skips honestly when they are absent):
 *   BOSON_API_KEY      - a valid Boson key (server-side, used to mint a secret)
 *   VAD_AB_WAV         - path to a 16-bit mono 24 kHz WAV of one spoken utterance
 *   VAD_AB_VALUES      - optional, default "650,550,500"
 *   VAD_AB_TURNS       - optional repeats per value, default 3
 *
 * A single pass per setting is NOT enough to choose a production value: aim for
 * >= 20 turns per candidate, in a quiet room, with a real prospect-like voice.
 * This script measures; it does not decide.
 */
import fs from 'node:fs';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { loadApiKey, mintEphemeralToken } from '../server';
import { buildSessionConfig } from '../src/realtime/events';

dotenv.config();

const WS_URL = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';

interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Buffer;
}

/** Minimal RIFF/WAVE reader for 16-bit PCM. */
function readWav(path: string): Wav {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bitsPerSample = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error('WAV file has no data chunk');
  return { sampleRate, channels, bitsPerSample, pcm: data };
}

interface TurnResult {
  speechStartedMs?: number;
  speechStoppedMs?: number;
  responseCreatedMs?: number;
  firstDeltaMs?: number;
  responseDoneMs?: number;
}

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runOneTurn(
  token: string,
  wav: Wav,
  silenceDurationMs: number
): Promise<TurnResult> {
  const result: TurnResult = {};

  return await new Promise<TurnResult>((resolve, reject) => {
    const ws = new WebSocket(WS_URL, ['realtime', `bai-client-secret.${token}`]);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error('turn timed out after 30s without response.done'));
    }, 30000);

    const finish = (err?: Error) => {
      clearTimeout(timeout);
      try {
        ws.close(1000, 'done');
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(result);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify(buildSessionConfig(undefined, { silence_duration_ms: silenceDurationMs })));

      // Pace the utterance in real time, exactly like the browser worklet (50 ms).
      const chunkBytes = Math.round(wav.sampleRate * 0.05 * 2);
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= wav.pcm.length) {
          clearInterval(timer);
          return;
        }
        const slice = wav.pcm.subarray(offset, Math.min(offset + chunkBytes, wav.pcm.length));
        offset += chunkBytes;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: slice.toString('base64') }));
      }, 50);
    });

    ws.on('message', (raw) => {
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const t = nowMs();
      switch (event.type) {
        case 'input_audio_buffer.speech_started':
          result.speechStartedMs ??= t;
          break;
        case 'input_audio_buffer.speech_stopped':
          result.speechStoppedMs ??= t;
          break;
        case 'response.created':
          result.responseCreatedMs ??= t;
          break;
        case 'response.output_text.delta':
          result.firstDeltaMs ??= t;
          break;
        case 'response.done':
          result.responseDoneMs ??= t;
          finish();
          break;
        case 'error':
          finish(new Error(`provider error: ${JSON.stringify(event.error ?? event)}`));
          break;
        default:
          break;
      }
    });

    ws.on('error', (err) => finish(err as Error));
  });
}

async function main() {
  console.log('=== VAD ENDPOINTING A/B HARNESS (requires a real provider session) ===\n');

  const apiKey = loadApiKey();
  const wavPath = process.env.VAD_AB_WAV;
  const values = (process.env.VAD_AB_VALUES || '650,550,500')
    .split(',')
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v));
  const turnsPerValue = parseInt(process.env.VAD_AB_TURNS || '3', 10);

  if (!apiKey) {
    console.log('SKIPPED: BOSON_API_KEY is not set, so no real provider session can be opened.');
    console.log('This harness cannot measure provider endpointing without a key — no results fabricated.');
    process.exit(0);
  }
  if (!wavPath) {
    console.log('SKIPPED: VAD_AB_WAV is not set (path to a 16-bit mono 24 kHz WAV utterance).');
    console.log('A synthetic tone cannot exercise VAD meaningfully, so no substitution was attempted.');
    process.exit(0);
  }

  const wav = readWav(wavPath);
  if (wav.sampleRate !== 24000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
    console.log(
      `SKIPPED: ${wavPath} must be 24000 Hz mono 16-bit PCM (got ${wav.sampleRate} Hz, ${wav.channels} ch, ${wav.bitsPerSample} bit).`
    );
    process.exit(0);
  }

  const token = await mintEphemeralToken(apiKey, 900);
  console.log(
    `Minted ephemeral secret ${token.value.slice(0, 11)}… | utterance ${(wav.pcm.length / 2 / wav.sampleRate).toFixed(2)}s | ${turnsPerValue} turns per value\n`
  );

  for (const silence of values) {
    const ttfts: number[] = [];
    const failures: string[] = [];

    for (let i = 0; i < turnsPerValue; i++) {
      try {
        const r = await runOneTurn(token.value, wav, silence);
        if (r.speechStoppedMs === undefined) {
          failures.push('no speech_stopped');
        } else if (r.firstDeltaMs === undefined) {
          failures.push('no text delta');
        } else {
          ttfts.push(Math.round(r.firstDeltaMs - r.speechStoppedMs));
        }
      } catch (err: any) {
        failures.push(err.message);
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log(
      `silence_duration_ms=${silence}: n=${ttfts.length}, median speech_stop→first_delta=${median(ttfts) ?? 'N/A'} ms` +
        (failures.length ? `, failures=${failures.length} (${failures.slice(0, 3).join('; ')})` : '')
    );
  }

  console.log('\nInterpretation: pick the LOWEST value whose transcript stays complete;');
  console.log('fragmented or truncated turns mean the window is too short regardless of latency.');
  console.log(`NOTE: n=${turnsPerValue} per value. This is a directional signal, not a decision.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('A/B harness failed:', err?.message || err);
  process.exit(1);
});
