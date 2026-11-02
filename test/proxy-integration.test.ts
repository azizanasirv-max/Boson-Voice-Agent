/**
 * Proxy integration tests.
 *
 * Unlike the pre-existing test/test-proxy-and-timing.ts (which re-implements the
 * proxy inline and therefore cannot fail when server.ts regresses), this suite
 * imports and exercises the REAL `attachRealtimeProxy` from server.ts against a
 * fake upstream "Boson" endpoint on loopback.
 *
 * This proves forwarding order, no frame loss, and forwarding overhead.
 * It does NOT prove real Boson behaviour or real network latency.
 */
import assert from 'node:assert';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { test, summary } from './harness';

interface UpstreamCapture {
  server: http.Server;
  port: number;
  received: Array<{ text: string; atHr: bigint }>;
  sockets: WebSocket[];
  close: () => Promise<void>;
}

async function startFakeUpstream(): Promise<UpstreamCapture> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const received: Array<{ text: string; atHr: bigint }> = [];
  const sockets: WebSocket[] = [];

  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      received.push({ text: data.toString(), atHr: process.hrtime.bigint() });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  return {
    server,
    port,
    received,
    sockets,
    close: async () => {
      for (const s of sockets) s.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function openClient(
  port: number,
  protocols: string[] = ['realtime', 'bai-client-secret.test-eph']
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/realtime`, protocols);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the proxy has opened a NEW upstream socket to the fake Boson. */
async function waitForUpstreamSocket(
  upstream: UpstreamCapture,
  baselineCount: number,
  timeoutMs = 4000
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = upstream.sockets[upstream.sockets.length - 1];
    if (candidate && upstream.sockets.length > baselineCount && candidate.readyState === WebSocket.OPEN) {
      return candidate;
    }
    await wait(15);
  }
  throw new Error('proxy did not open an upstream socket in time');
}

async function run() {
  console.log('=== PROXY INTEGRATION TESTS (real attachRealtimeProxy, fake upstream) ===\n');

  const upstream = await startFakeUpstream();
  // BOSON_BASE_URL is read at server-module load time, so set it first.
  process.env.BOSON_BASE_URL = `http://127.0.0.1:${upstream.port}`;
  const { attachRealtimeProxy } = await import('../server');

  const proxyServer = http.createServer();
  attachRealtimeProxy(proxyServer);
  await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxyServer.address() as any).port;

  await test('Connection without an ephemeral token is rejected with 4401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/ws/realtime`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c: number) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    assert.strictEqual(code, 4401);
  });

  await test('Steady-state: session.update and audio appends are forwarded in order, without loss', async () => {
    upstream.received.length = 0;
    const baseline = upstream.sockets.length;
    const client = await openClient(proxyPort);
    await waitForUpstreamSocket(upstream, baseline);

    const appends = 50;
    const sendTimes: bigint[] = [];
    const payloads: string[] = [];

    const sessionUpdate = JSON.stringify({
      type: 'session.update',
      session: { output_modalities: ['text'] },
    });
    payloads.push(sessionUpdate);
    sendTimes.push(process.hrtime.bigint());
    client.send(sessionUpdate);

    for (let i = 0; i < appends; i++) {
      const payload = JSON.stringify({ type: 'input_audio_buffer.append', audio: `frame-${i}` });
      payloads.push(payload);
      sendTimes.push(process.hrtime.bigint());
      client.send(payload);
    }

    for (let i = 0; i < 200 && upstream.received.length < payloads.length; i++) await wait(10);

    assert.strictEqual(upstream.received.length, payloads.length, 'every frame must be forwarded');
    assert.deepStrictEqual(
      upstream.received.map((r) => r.text),
      payloads,
      'frames must arrive in the exact order they were sent'
    );

    const overheadMs = upstream.received.map((r, i) => Number(r.atHr - sendTimes[i]) / 1e6);
    const sorted = overheadMs.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];

    console.log(
      `   forwarding overhead: median ${median.toFixed(2)} ms, max ${max.toFixed(2)} ms over ${overheadMs.length} frames`
    );
    assert.ok(median < 25, `median forwarding overhead must be small, got ${median.toFixed(2)}ms`);
    assert.ok(max < 250, `worst-case forwarding overhead must stay bounded, got ${max.toFixed(2)}ms`);

    client.close();
  });

  await test('Pre-open race: frames sent before the upstream opens are queued and replayed in order', async () => {
    upstream.received.length = 0;
    const client = await openClient(proxyPort);

    // Fire immediately, deliberately before the upstream socket can be open.
    const payloads = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ type: 'input_audio_buffer.append', audio: `early-${i}` })
    );
    for (const p of payloads) client.send(p);

    for (let i = 0; i < 300 && upstream.received.length < payloads.length; i++) await wait(10);

    assert.deepStrictEqual(
      upstream.received.map((r) => r.text),
      payloads,
      'queued frames must be flushed in their original order'
    );
    client.close();
  });

  await test('Server events are relayed upstream -> client', async () => {
    const baseline = upstream.sockets.length;
    const client = await openClient(proxyPort);
    const upstreamSocket = await waitForUpstreamSocket(upstream, baseline);

    const incoming = new Promise<string>((resolve) =>
      client.once('message', (d: any) => resolve(d.toString()))
    );
    upstreamSocket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hello' }));

    const text = await incoming;
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /hello/);
    client.close();
  });

  await test('Client disconnect tears down the upstream socket', async () => {
    const baseline = upstream.sockets.length;
    const client = await openClient(proxyPort);
    const lastSocket = await waitForUpstreamSocket(upstream, baseline);

    const closed = new Promise<void>((resolve) => lastSocket.once('close', () => resolve()));
    client.close();
    await Promise.race([closed, wait(2000)]);
    assert.strictEqual(lastSocket.readyState, WebSocket.CLOSED, 'upstream socket must close with the client');
  });

  await test('Client closing with no status code (1005) must not crash the proxy', async () => {
    const baseline = upstream.sockets.length;
    const client = await openClient(proxyPort);
    await waitForUpstreamSocket(upstream, baseline);

    // ws reports 1005 "no status received" here, exactly like a tab closing.
    client.close();
    await wait(200);

    // If the close handler had thrown, this process would be dead and the
    // following connection would never open.
    const nextBaseline = upstream.sockets.length;
    const survivor = await openClient(proxyPort);
    const upstreamSocket = await waitForUpstreamSocket(upstream, nextBaseline);
    assert.strictEqual(upstreamSocket.readyState, WebSocket.OPEN, 'proxy must still serve new sessions');
    survivor.close(1000, 'done');
  });

  await test('Close codes and reasons are sanitised before being forwarded', async () => {
    const { sanitizeCloseCode, sanitizeCloseReason } = await import('../server');

    // Reserved / unsendable codes fall back to 1000 instead of throwing.
    assert.strictEqual(sanitizeCloseCode(1005), 1000);
    assert.strictEqual(sanitizeCloseCode(1006), 1000);
    assert.strictEqual(sanitizeCloseCode(1004), 1000);
    assert.strictEqual(sanitizeCloseCode(1015), 1000);
    assert.strictEqual(sanitizeCloseCode(2999), 1000);
    assert.strictEqual(sanitizeCloseCode(0), 1000);
    assert.strictEqual(sanitizeCloseCode(NaN), 1000);

    // Legitimate codes pass through untouched.
    assert.strictEqual(sanitizeCloseCode(1000), 1000);
    assert.strictEqual(sanitizeCloseCode(1001), 1001);
    assert.strictEqual(sanitizeCloseCode(1011), 1011);
    assert.strictEqual(sanitizeCloseCode(1013), 1013);
    assert.strictEqual(sanitizeCloseCode(3000), 3000);
    assert.strictEqual(sanitizeCloseCode(4401), 4401);
    assert.strictEqual(sanitizeCloseCode(4429), 4429);

    // Reasons are capped at 123 bytes per the spec.
    assert.strictEqual(sanitizeCloseReason(undefined), '');
    assert.ok(Buffer.byteLength(sanitizeCloseReason('x'.repeat(500))) <= 123);
  });

  await test('Overflow drop policy never splices the stream or drops the session update', async () => {
    const { selectDropIndex } = await import('../server');

    const queue = [
      { kind: 'session.update' },
      { kind: 'input_audio_buffer.append' },
      { kind: 'input_audio_buffer.append' },
      { kind: 'response.create' },
    ];

    // Oldest audio is index 1: a gap at the head is safe, a splice in the middle is not.
    assert.strictEqual(selectDropIndex(queue), 1);

    // With no audio queued, never drop index 0 (the session handshake).
    const controlOnly = [{ kind: 'session.update' }, { kind: 'response.create' }];
    assert.strictEqual(selectDropIndex(controlOnly), 1);

    assert.strictEqual(selectDropIndex([]), -1);
    assert.strictEqual(selectDropIndex([{ kind: 'session.update' }]), 0);

    const working = queue.slice();
    for (let i = 0; i < 5; i++) {
      const idx = selectDropIndex(working);
      if (idx >= 0) working.splice(idx, 1);
    }
    assert.ok(
      working.every((m) => m.kind !== 'input_audio_buffer.append'),
      'audio frames are shed before control events'
    );
  });

  summary('PROXY INTEGRATION TESTS');

  await new Promise<void>((r) => proxyServer.close(() => r()));
  await upstream.close();
}

run().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});
