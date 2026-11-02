/**
 * Session configuration + pure helper regression tests.
 * Validates the emitted protocol shape against the provider's documented schema
 * (docs.boson.ai/asyncapi.json) and the latency/diagnostics helpers.
 */
import assert from 'node:assert';
import {
  DEFAULT_VAD_CONFIG,
  VAD_ALLOWED_FIELDS,
  buildSessionConfig,
  buildTurnDetection,
  DEFAULT_SALES_COPILOT_INSTRUCTIONS,
  responseCancel,
} from '../src/realtime/events';
import { percentile, generateFullDiagnosticReport, redactSecrets } from '../src/realtime/diagnostics';
import { computeSlowestStage } from '../src/realtime/RealtimeClient';
import { test, summary } from './harness';

interface SessionShape {
  output_modalities: string[];
  instructions: string;
  audio: {
    input: {
      format: { type: string; rate: number };
      turn_detection: Record<string, unknown>;
      transcription: { model: string };
    };
  };
}

function sessionOf(event: any): SessionShape {
  return event.session;
}

async function run() {
  console.log('=== SESSION CONFIG + PURE HELPER TESTS ===\n');

  await test('Session emits text-only modality and 24 kHz mono PCM input', () => {
    const session = sessionOf(buildSessionConfig());
    assert.deepStrictEqual(session.output_modalities, ['text'], 'assistant audio must never be requested');
    assert.strictEqual(session.audio.input.format.type, 'audio/pcm');
    assert.strictEqual(session.audio.input.format.rate, 24000);
    assert.strictEqual(session.audio.input.transcription.model, 'higgs-stt-3.1');
  });

  await test('turn_detection contains only provider-whitelisted fields', () => {
    const td = sessionOf(buildSessionConfig()).audio.input.turn_detection;
    assert.deepStrictEqual(Object.keys(td).sort(), [...VAD_ALLOWED_FIELDS].sort());
    assert.strictEqual(td.type, 'server_vad');
  });

  await test('Protocol-illegal turn_detection keys are rejected, never sent', () => {
    // The provider declares additionalProperties: false; these would close the session.
    assert.throws(() => buildTurnDetection({ create_response: true } as any), /not part of the Boson Higgs Realtime protocol/);
    assert.throws(() => buildTurnDetection({ interrupt_response: true } as any), /not part of the Boson Higgs Realtime protocol/);
    assert.throws(() => buildTurnDetection({ nonsense_field: 1 } as any), /Unknown turn_detection field/);
  });

  await test('VAD values are clamped to the provider range', () => {
    const high = buildTurnDetection({ threshold: 5 });
    const low = buildTurnDetection({ threshold: -3, silence_duration_ms: -100 });
    assert.strictEqual(high.threshold, 1);
    assert.strictEqual(low.threshold, 0);
    assert.strictEqual(low.silence_duration_ms, 0);
  });

  await test('Default endpointing values are exactly the documented baseline', () => {
    assert.strictEqual(DEFAULT_VAD_CONFIG.threshold, 0.5);
    assert.strictEqual(DEFAULT_VAD_CONFIG.prefix_padding_ms, 300);
    assert.strictEqual(DEFAULT_VAD_CONFIG.silence_duration_ms, 350);
    assert.strictEqual(DEFAULT_VAD_CONFIG.min_speech_duration, 0.125);

    const td = buildTurnDetection();
    assert.strictEqual(td.silence_duration_ms, 350);
    assert.strictEqual(td.min_speech_duration, 0.125);
  });

  await test('VAD A/B overrides pass through unchanged (harness support)', () => {
    for (const silence of [650, 550, 500]) {
      const td = buildTurnDetection({ silence_duration_ms: silence });
      assert.strictEqual(td.silence_duration_ms, silence);
      assert.strictEqual(td.threshold, 0.5, 'only silence may change in a fair A/B run');
    }
  });

  await test('Sales copilot instructions are preserved in full', () => {
    const session = sessionOf(buildSessionConfig());
    assert.strictEqual(session.instructions, DEFAULT_SALES_COPILOT_INSTRUCTIONS);
    assert.ok(session.instructions.length > 500, 'instructions must not be truncated');
    assert.ok(session.instructions.includes('$250'), 'approved pricing must survive');
    assert.ok(session.instructions.includes('2 client locations'));
    assert.match(session.instructions, /STRICT FACTUALITY/);
    assert.match(session.instructions, /human salesperson/i);
  });

  await test('response.cancel is available for interruption handling', () => {
    assert.strictEqual(responseCancel().type, 'response.cancel');
  });

  await test('percentile computes median / p95 / extremes correctly', () => {
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    assert.strictEqual(percentile(samples, 50), 500);
    assert.strictEqual(percentile(samples, 95), 1000);
    assert.strictEqual(percentile(samples, 0), 100);
    assert.strictEqual(percentile(samples, 100), 1000);
    assert.strictEqual(percentile([], 50), undefined);
    assert.strictEqual(percentile([420], 95), 420);
  });

  await test('computeSlowestStage names the dominant stage', () => {
    assert.strictEqual(
      computeSlowestStage({
        speechEndToCommittedMs: 20,
        committedToTranscriptionMs: 120,
        responseCreatedToFirstDeltaMs: 40,
      }),
      'committed→transcription'
    );
    assert.strictEqual(
      computeSlowestStage({ speechEndToCommittedMs: 5, responseCreatedToFirstDeltaMs: 400 }),
      'response-created→first-delta'
    );
    assert.strictEqual(computeSlowestStage({}), undefined);
  });

  await test('Diagnostics report aggregates 20 turns into median and p95', () => {
    const turnHistory = Array.from({ length: 20 }, (_, i) => ({
      turnId: `turn-${i}`,
      timestamp: Date.now(),
      speechEndToFirstRenderMs: 500 + i * 50, // 500..1450
      status: 'complete' as const,
      slowestStage: i < 15 ? 'response-created→first-delta' : 'committed→transcription',
    }));

    const report = generateFullDiagnosticReport({
      connectStartTime: Date.now() - 60000,
      completedTurns: 20,
      reconnectAttempts: 0,
      micState: 'recording',
      micHealth: {
        state: 'recording',
        frameCount: 2400,
        framesDropped: 3,
        lastFrameAt: Date.now(),
        flowing: true,
        deviceLabel: 'MacBook Pro Microphone',
      },
      audioFramesDropped: 3,
      isResponseStreaming: false,
      closeInfo: null,
      telemetry: null,
      logs: [],
      droppedLogCount: 0,
      bufferedAmountHistory: [],
      speechStartedCount: 20,
      speechStoppedCount: 20,
      speechCommittedCount: 20,
      transcriptionCount: 20,
      transcriptionFailureCount: 0,
      responseCreatedCount: 20,
      interruptedResponseCount: 0,
      turnHistory,
    });

    assert.match(report, /Samples with a latency value: 20/);
    assert.match(report, /Median Speech-End-to-First-Text: 950 ms/);
    // Nearest-rank p95 over 20 samples is the 19th value: 500 + 18*50 = 1400.
    assert.match(report, /p95 Speech-End-to-First-Text: 1400 ms/);
    assert.match(report, /Maximum: 1450 ms/);
    assert.match(report, /Turns without input_audio_buffer\.speech_stopped: 0/);
    assert.match(report, /Most frequent slowest stage: response-created→first-delta \(15 turns\)/);
    assert.match(report, /Microphone Audio Flowing: yes/);
    assert.match(report, /Microphone Frames Dropped \(socket not writable\): 3/);
    assert.doesNotMatch(report, /NaN/);
  });

  await test('Secret redaction still strips tokens from reports', () => {
    const redacted = redactSecrets('Bearer sk-abcdef123456 and bai-eph-xyz789') as string;
    assert.ok(!redacted.includes('sk-abcdef123456'));
    assert.ok(!redacted.includes('bai-eph-xyz789'));
  });

  summary('SESSION CONFIG + PURE HELPER TESTS');
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
