/**
 * Audio DSP regression tests: resampling accuracy, PCM16 encoding, anti-aliasing.
 * Pure functions only — no browser APIs, no provider connection.
 */
import assert from 'node:assert';
import { createResampler, createLowpass, floatTo16BitPCM } from '../src/audio/resample';
import { BOSON_AUDIO_RATE, MIC_FRAME_MS, buildCaptureWorkletSource, computeRms } from '../src/audio/capture';
import { test, summary } from './harness';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(a: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / Math.max(1, a.length));
}

async function run() {
  console.log('=== AUDIO PIPELINE REGRESSION TESTS (synthetic, no microphone) ===\n');

  await test('Resampler: 48kHz -> 24kHz produces exactly half the samples over 1s', () => {
    const input = sine(440, 48000, 1);
    const resampler = createResampler(48000, BOSON_AUDIO_RATE);

    // Feed in 50 ms frames exactly as the worklet does.
    const frameSize = 48000 * 0.05;
    let out = 0;
    for (let offset = 0; offset < input.length; offset += frameSize) {
      const frame = input.subarray(offset, Math.min(offset + frameSize, input.length));
      out += resampler.process(frame).length;
    }

    assert.strictEqual(BOSON_AUDIO_RATE, 24000);
    assert.ok(Math.abs(out - 24000) <= 2, `expected ~24000 output samples, got ${out}`);
  });

  await test('Resampler: 44.1kHz -> 24kHz keeps 1s of audio ~1s long (non-integer ratio)', () => {
    const input = sine(440, 44100, 1);
    const resampler = createResampler(44100, BOSON_AUDIO_RATE);

    const frameSize = Math.round(44100 * 0.05);
    let out = 0;
    for (let offset = 0; offset < input.length; offset += frameSize) {
      const frame = input.subarray(offset, Math.min(offset + frameSize, input.length));
      out += resampler.process(frame).length;
    }

    // One sample of drift per block boundary is acceptable; a lost/duplicated
    // 10 ms of audio is not.
    assert.ok(Math.abs(out - 24000) <= 8, `expected ~24000 output samples, got ${out}`);
  });

  await test('Resampler: rejects out-of-band audio instead of letting it alias', () => {
    const inBand = sine(2000, 48000, 0.5, 0.5);
    const outOfBand = sine(18000, 48000, 0.5, 0.5); // above the ~10.8 kHz cutoff

    const inRms = rms(createResampler(48000, BOSON_AUDIO_RATE).process(inBand));
    const outRms = rms(createResampler(48000, BOSON_AUDIO_RATE).process(outOfBand));

    assert.ok(inRms > 0.2, `in-band tone should survive, rms=${inRms}`);
    assert.ok(
      outRms < inRms * 0.1,
      `18 kHz tone must be attenuated by the anti-alias filter (in=${inRms.toFixed(4)}, out=${outRms.toFixed(4)})`
    );
  });

  await test('Lowpass: preserves passband level and never emits NaN/Infinity', () => {
    const lpf = createLowpass(10800, 48000);
    const out = lpf.process(sine(500, 48000, 0.2, 0.4));
    assert.ok(out.every((v) => Number.isFinite(v)), 'filter output must be finite');
    const tail = out.subarray(out.length - 2000);
    assert.ok(rms(tail) > 0.2, `passband should survive, rms=${rms(tail)}`);
  });

  await test('PCM16: little-endian byte order and symmetric clipping', () => {
    const pcm = floatTo16BitPCM(Float32Array.from([1.0, -1.0, 2.0, -2.0, 0]));
    const int16 = new Int16Array(pcm);
    const bytes = new Uint8Array(pcm);

    // little-endian: 0x7FFF -> FF 7F
    assert.strictEqual(bytes[0], 0xff);
    assert.strictEqual(bytes[1], 0x7f);
    // little-endian: -32768 -> 00 80
    assert.strictEqual(bytes[2], 0x00);
    assert.strictEqual(bytes[3], 0x80);

    assert.strictEqual(int16[0], 32767, '+1.0 clamps to 32767');
    assert.strictEqual(int16[1], -32768, '-1.0 clamps to -32768');
    assert.strictEqual(int16[2], 32767, '+2.0 clamps, no wrap-around');
    assert.strictEqual(int16[3], -32768, '-2.0 clamps, no wrap-around');
    assert.strictEqual(int16[4], 0, 'silence encodes to zero');
  });

  await test('PCM16: encoding 24 kHz 50 ms frame yields the expected byte count', () => {
    const samples = 24000 * (MIC_FRAME_MS / 1000);
    const pcm = floatTo16BitPCM(new Float32Array(samples));
    assert.strictEqual(samples, 1200, '50 ms at 24 kHz is 1200 samples');
    assert.strictEqual(pcm.byteLength, 2400, 'PCM16 mono 50 ms is 2400 bytes');
  });

  await test('Worklet source is generated from MIC_FRAME_MS (single source of truth)', () => {
    const source = buildCaptureWorkletSource();
    assert.ok(source.includes('sampleRate * 0.050000'), 'worklet must derive a 50 ms frame');
    assert.ok(source.includes("registerProcessor('capture-processor'"), 'processor must be registered');
    assert.ok(source.includes('postMessage(this.buf.buffer, [this.buf.buffer])'), 'frames transfer without an extra copy');
  });

  await test('computeRms: silence is 0, full-scale sine is ~0.707', () => {
    assert.strictEqual(computeRms(new Float32Array(100)), 0);
    const r = computeRms(sine(200, 24000, 0.05, 1));
    assert.ok(Math.abs(r - Math.SQRT1_2) < 0.02, `expected ~0.707, got ${r}`);
  });

  summary('AUDIO PIPELINE TESTS');
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
