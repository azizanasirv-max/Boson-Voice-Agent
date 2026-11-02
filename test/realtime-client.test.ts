/**
 * RealtimeClient state-machine regression tests.
 * Uses a fake WebSocket + fake token endpoint + fake capture implementation.
 * Proves socket-generation safety, single-flight mic start, and that first-render
 * latency is measured rather than fabricated.
 */
import assert from 'node:assert';
import { RealtimeClient } from '../src/realtime/RealtimeClient';
import type { MicCaptureCallbacks, MicCaptureLike } from '../src/audio/capture';
import type { ConversationMessage, MicHealth, MicState } from '../src/realtime/types';
import { test, summary } from './harness';

// ------------------------------------------------------------------- fakes

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  protocols: string[];
  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols ?? [];
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  simulateClose(code = 1000, reason = 'normal') {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  static latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    assert.ok(ws, 'expected a WebSocket to have been created');
    return ws;
  }
}

interface FakeCaptureOptions {
  startError?: Error;
}

class FakeCapture implements MicCaptureLike {
  started = false;
  stopCalls = 0;
  active = false;
  currentState: MicState = 'idle';
  framesReceived = 0;
  lastFrameAt = 0;
  private behavior: FakeCaptureOptions;

  constructor(public callbacks: MicCaptureCallbacks, behavior: FakeCaptureOptions = {}) {
    this.behavior = behavior;
  }

  async start(): Promise<void> {
    if (this.behavior.startError) throw this.behavior.startError;
    this.started = true;
    this.active = true;
    this.currentState = 'recording';
    this.callbacks.onStateChange?.('recording');
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this.active = false;
    this.currentState = 'idle';
  }

  isFlowing(): boolean {
    return this.active;
  }

  getHealth(): MicHealth {
    return {
      state: this.currentState,
      frameCount: this.framesReceived,
      framesDropped: 0,
      lastFrameAt: this.lastFrameAt,
      flowing: this.active,
    };
  }

  /** Simulates one capture frame reaching the client. */
  pushFrame(b64 = 'AAAA') {
    this.framesReceived++;
    this.lastFrameAt = Date.now();
    this.callbacks.onChunk(b64);
  }
}

let createdCaptures: FakeCapture[] = [];
let captureStartError: Error | undefined;

function installStubs() {
  FakeWebSocket.instances = [];
  createdCaptures = [];
  captureStartError = undefined;

  Object.defineProperty(globalThis, 'WebSocket', {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
  (globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ value: 'bai-eph-test-token', expires_at: 1900000000 }),
  });
}

function makeClient(events: ConversationMessage[] = []) {
  return new RealtimeClient({
    onMessageAdded: (m) => events.push(m),
    micCaptureFactory: (cb) => {
      const capture = new FakeCapture(cb, { startError: captureStartError });
      createdCaptures.push(capture);
      return capture;
    },
  });
}

async function run() {
  console.log('=== REALTIME CLIENT STATE-MACHINE TESTS (fake socket, no provider) ===\n');

  await test('A stale socket close must not kill the new session or its microphone', async () => {
    installStubs();
    const client = makeClient();

    await client.connect();
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();
    assert.strictEqual(client.getStatus(), 'connected');

    await client.startMic();
    const capture1 = createdCaptures[0];
    assert.strictEqual(client.isMicActive(), true);

    // Reconnect cycle: close the first session and open a brand-new one.
    client.disconnect();
    await client.connect();
    const ws2 = FakeWebSocket.latest();
    assert.notStrictEqual(ws1, ws2, 'a new socket must be created');
    ws2.simulateOpen();
    await client.startMic();
    const capture2 = createdCaptures[1];
    assert.strictEqual(client.isMicActive(), true);

    // The FIRST socket's close finally arrives (always late in the real world).
    ws1.simulateClose(1000, 'late close from superseded socket');

    assert.strictEqual(client.getStatus(), 'connected', 'stale close must not change live status');
    assert.strictEqual(client.isMicActive(), true, 'stale close must not stop the live microphone');
    assert.strictEqual(capture2.stopCalls, 0, 'live capture must not be torn down');
    assert.ok(capture1.stopCalls >= 1, 'the old capture must have been stopped by disconnect');
  });

  await test('A stale socket message is ignored (no cross-session corruption)', async () => {
    installStubs();
    const events: ConversationMessage[] = [];
    const client = makeClient(events);

    await client.connect();
    const ws1 = FakeWebSocket.latest();
    ws1.simulateOpen();

    client.disconnect();
    await client.connect();
    const ws2 = FakeWebSocket.latest();
    ws2.simulateOpen();

    const before = events.length;
    ws1.simulateMessage({ type: 'input_audio_buffer.speech_started', item_id: 'stale-item' });
    assert.strictEqual(events.length, before, 'stale events must not create conversation items');

    ws2.simulateMessage({ type: 'input_audio_buffer.speech_started', item_id: 'live-item' });
    assert.strictEqual(events.length, before + 1, 'live events must still be processed');
    assert.strictEqual(events[events.length - 1].id, 'live-item');
  });

  await test('Rapid double startMic opens exactly one capture session', async () => {
    installStubs();
    const client = makeClient();
    await client.connect();
    FakeWebSocket.latest().simulateOpen();

    const first = client.startMic();
    const second = client.startMic();
    await Promise.all([first, second]);

    assert.strictEqual(createdCaptures.length, 1, 'double click must not create two capture sessions');
    assert.strictEqual(client.isMicActive(), true);
  });

  await test('First-render latency is measured, not hardcoded to zero', async () => {
    installStubs();
    const events: ConversationMessage[] = [];
    const client = makeClient(events);
    await client.connect();
    const ws = FakeWebSocket.latest();
    ws.simulateOpen();

    ws.simulateMessage({ type: 'input_audio_buffer.speech_started', item_id: 'item-1', audio_start_ms: 0 });
    ws.simulateMessage({ type: 'input_audio_buffer.speech_stopped', item_id: 'item-1', audio_end_ms: 900 });
    ws.simulateMessage({ type: 'response.created', response: { id: 'resp-1', status: 'in_progress' } });
    ws.simulateMessage({
      type: 'response.output_text.delta',
      response_id: 'resp-1',
      item_id: 'resp-1',
      delta: 'Start with the two-location package.',
    });

    const beforeRender = client.getExtendedDiagnosticsData().latencyMetrics || {};
    assert.strictEqual(
      beforeRender.firstDeltaToFirstRenderMs,
      undefined,
      'render latency must be unknown until the UI actually paints (never 0)'
    );
    assert.strictEqual(typeof beforeRender.speechEndToFirstVisibleTextMs, 'number', 'delta receipt IS known');

    // The UI reports the paint time slightly in the future of "now".
    const renderedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 7;
    client.markFirstRender('resp-1', renderedAt);

    const after = client.getExtendedDiagnosticsData().latencyMetrics || {};
    assert.ok(
      (after.firstDeltaToFirstRenderMs ?? -1) >= 5,
      `first-delta -> render must be a real measurement, got ${after.firstDeltaToFirstRenderMs}`
    );
    assert.strictEqual(typeof after.speechEndToFirstRenderMs, 'number');
  });

  summary('REALTIME CLIENT TESTS');
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
