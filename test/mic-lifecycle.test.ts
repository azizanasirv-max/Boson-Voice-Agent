/**
 * Microphone lifecycle regression tests.
 * These exercise the real `MicCapture` class against *stubbed* browser audio APIs
 * (getUserMedia / AudioContext / AudioWorkletNode). This is NOT a physical
 * microphone test — it proves the lifecycle logic, not acoustic capture.
 */
import assert from 'node:assert';
import {
  MicCapture,
  FIRST_FRAME_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  STALL_CHECK_INTERVAL_MS,
} from '../src/audio/capture';
import type { MicState } from '../src/realtime/types';
import { test, summary } from './harness';

// ---------------------------------------------------------------- browser stubs

interface FakeTrack {
  kind: string;
  label: string;
  stopped: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  stop(): void;
  emit(type: string): void;
}

function makeTrack(): FakeTrack {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    kind: 'audio',
    label: 'Test Microphone',
    stopped: false,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    stop() {
      this.stopped = true;
    },
    emit(type) {
      for (const fn of listeners[type] || []) fn();
    },
  };
}

class FakeGainNode {
  gain = { value: 1 };
  connectedTo: any[] = [];
  connect(target: any) {
    this.connectedTo.push(target);
  }
  disconnect() {
    this.connectedTo = [];
  }
}

class FakeSourceNode {
  connect(_target: any) {}
  disconnect() {}
}

class FakeWorkletNode {
  port: any;
  connectedTo: any[] = [];
  constructor() {
    this.port = {
      onmessage: null as null | ((e: MessageEvent) => void),
      onmessageerror: null as null | (() => void),
      close: () => {},
    };
  }
  connect(target: any) {
    this.connectedTo.push(target);
  }
  disconnect() {
    this.connectedTo = [];
  }
}

interface CtxOptions {
  sampleRate?: number;
  state?: 'running' | 'suspended';
  resumeWorks?: boolean;
  failWorklet?: boolean;
}

let lastCtx: FakeAudioContext | null = null;
let lastWorkletNode: FakeWorkletNode | null = null;

class FakeAudioContext {
  sampleRate: number;
  state: 'running' | 'suspended';
  destination = { id: 'destination' };
  closed = false;
  private resumeWorks: boolean;
  audioWorklet: { addModule: (url: string) => Promise<void> };
  static options: CtxOptions = {};

  constructor() {
    const opts = FakeAudioContext.options;
    this.sampleRate = opts.sampleRate ?? 48000;
    this.state = opts.state ?? 'running';
    this.resumeWorks = opts.resumeWorks ?? true;
    this.audioWorklet = {
      addModule: async () => {
        if (opts.failWorklet) throw new Error('worklet module failed to load');
      },
    };
    lastCtx = this;
  }

  createMediaStreamSource(_stream: any) {
    return new FakeSourceNode();
  }
  createGain() {
    return new FakeGainNode();
  }
  async resume() {
    if (this.resumeWorks) this.state = 'running';
  }
  async close() {
    this.closed = true;
  }
}

let currentTrack: FakeTrack = makeTrack();
let getUserMediaCalls = 0;

function installBrowserStubs(ctxOptions: CtxOptions = {}) {
  FakeAudioContext.options = ctxOptions;
  getUserMediaCalls = 0;
  currentTrack = makeTrack();
  lastCtx = null;
  lastWorkletNode = null;

  // Node 24 exposes `navigator` as a getter-only global, so define it explicitly.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCalls++;
          return { getTracks: () => [currentTrack] };
        },
      },
    },
    configurable: true,
    writable: true,
  });
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).AudioWorkletNode = class extends FakeWorkletNode {
    constructor(..._args: any[]) {
      super();
      lastWorkletNode = this;
    }
  };
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:capture-worklet', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true });
  }
}

/** Pushes one 50 ms Float32 frame through the worklet port, as the browser would. */
function emitFrame(samples = 2400, amplitude = 0.25) {
  const frame = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    frame[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / 48000);
  }
  lastWorkletNode?.port.onmessage?.({ data: frame.buffer } as MessageEvent);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------- tests
async function run() {
  console.log('=== MICROPHONE LIFECYCLE TESTS (stubbed browser audio APIs) ===\n');

  await test('Failure after getUserMedia stops the track (no hot microphone)', async () => {
    installBrowserStubs({ failWorklet: true });
    const capture = new MicCapture({ onChunk: () => {} });

    await assert.rejects(() => capture.start(), /worklet module failed to load/);

    assert.strictEqual(currentTrack.stopped, true, 'microphone track MUST be stopped on setup failure');
    assert.strictEqual(lastCtx?.closed, true, 'AudioContext MUST be closed on setup failure');
    assert.strictEqual(capture.active, false, 'capture must not claim to be active');
  });

  await test('Blocked AudioContext is reported as an error, not as recording', async () => {
    installBrowserStubs({ state: 'suspended', resumeWorks: false });
    const states: MicState[] = [];
    const capture = new MicCapture({ onChunk: () => {}, onStateChange: (s) => states.push(s) });

    await assert.rejects(() => capture.start(), /AudioContext state: suspended/);

    assert.strictEqual(capture.active, false);
    assert.strictEqual(currentTrack.stopped, true, 'track must be released when the graph cannot run');
    assert.ok(!states.includes('recording'), 'must never report recording while the graph is suspended');
  });

  await test('Microphone is routed through a zero-gain sink, never to speakers', async () => {
    installBrowserStubs({ state: 'running' });
    const capture = new MicCapture({ onChunk: () => {} });
    await capture.start();

    const gain = lastWorkletNode?.connectedTo[0] as FakeGainNode;
    assert.ok(gain instanceof FakeGainNode, 'worklet node must connect to the sink gain');
    assert.strictEqual(gain.gain.value, 0, 'sink gain must be 0 to prevent side-tone/feedback');
    assert.deepStrictEqual(gain.connectedTo, [lastCtx?.destination], 'only the muted sink reaches destination');

    await capture.stop();
  });

  await test('Track ended surfaces as disconnected state', async () => {
    installBrowserStubs();
    const states: Array<{ state: MicState; detail?: string }> = [];
    const capture = new MicCapture({
      onChunk: () => {},
      onStateChange: (state, detail) => states.push({ state, detail }),
    });
    await capture.start();
    emitFrame();

    currentTrack.emit('ended');

    const last = states[states.length - 1];
    assert.strictEqual(last.state, 'disconnected');
    assert.match(String(last.detail), /track ended/i);

    await capture.stop();
  });

  await test('System mute / unmute transition to muted and back to recording', async () => {
    installBrowserStubs();
    const states: MicState[] = [];
    const capture = new MicCapture({ onChunk: () => {}, onStateChange: (s) => states.push(s) });
    await capture.start();

    currentTrack.emit('mute');
    assert.strictEqual(capture.currentState, 'muted');

    currentTrack.emit('unmute');
    assert.strictEqual(capture.currentState, 'recording');
    assert.ok(states.includes('muted'));

    await capture.stop();
  });

  await test('Frames are resampled to 24000 Hz PCM16 and emitted as base64 chunks', async () => {
    installBrowserStubs({ sampleRate: 48000 });
    const chunks: string[] = [];
    const capture = new MicCapture({ onChunk: (b64) => chunks.push(b64) });
    await capture.start();

    emitFrame(2400); // 50 ms @ 48 kHz

    assert.strictEqual(chunks.length, 1, 'exactly one chunk per frame');
    const bytes = Buffer.from(chunks[0], 'base64');
    assert.strictEqual(bytes.length, 2400, '50 ms @ 24 kHz mono PCM16 == 2400 bytes');
    assert.ok(bytes.some((b) => b !== 0), 'chunk must contain real audio, not silence');
    assert.ok(capture.isFlowing(), 'frames just arrived, so audio is flowing');
    assert.strictEqual(capture.getHealth().frameCount, 1);

    await capture.stop();
  });

  await test('A stalled audio graph is detected instead of silently looking healthy', async () => {
    installBrowserStubs();
    const states: Array<{ state: MicState; detail?: string }> = [];
    const capture = new MicCapture({
      onChunk: () => {},
      onStateChange: (state, detail) => states.push({ state, detail }),
    });
    await capture.start();
    emitFrame();

    // No further frames: the graph stopped rendering.
    await wait(STALL_TIMEOUT_MS + STALL_CHECK_INTERVAL_MS + 200);

    const last = states[states.length - 1];
    assert.strictEqual(last.state, 'error');
    assert.match(String(last.detail), /stalled/i);
    assert.strictEqual(capture.isFlowing(), false, 'stalled capture must not report flowing');

    await capture.stop();
  });

  await test('A microphone that produces no frames is flagged after the first-frame timeout', async () => {
    installBrowserStubs();
    const states: Array<{ state: MicState; detail?: string }> = [];
    const capture = new MicCapture({
      onChunk: () => {},
      onStateChange: (state, detail) => states.push({ state, detail }),
    });
    await capture.start();

    await wait(FIRST_FRAME_TIMEOUT_MS + 250);

    const last = states[states.length - 1];
    assert.strictEqual(last.state, 'error');
    assert.match(String(last.detail), /No audio frames/);

    await capture.stop();
  });

  await test('stop() releases tracks, closes the context and clears state', async () => {
    installBrowserStubs();
    const capture = new MicCapture({ onChunk: () => {} });
    await capture.start();
    const ctx = lastCtx;

    await capture.stop();

    assert.strictEqual(currentTrack.stopped, true);
    assert.strictEqual(ctx?.closed, true);
    assert.strictEqual(capture.active, false);
    assert.strictEqual(capture.currentState, 'idle');
    assert.strictEqual(capture.getHealth().frameCount, 0);
  });

  summary('MICROPHONE LIFECYCLE TESTS');
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
