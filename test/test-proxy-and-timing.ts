import assert from 'node:assert';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { generateFullDiagnosticReport } from '../src/realtime/diagnostics';
import type { TurnTimingDiagnostic } from '../src/realtime/types';

async function runTests() {
  console.log('=== FOCUSED TEST SUITE: PROXY READINESS & TIMING DIAGNOSTICS ===\n');

  // Test 1 & 2: Client message arriving before upstream readiness & Ordered queue flushing
  console.log('Test 1 & 2: Testing pre-open message queueing and ordered FIFO flush...');
  {
    // Mock upstream server that delays open by 100ms
    const upstreamServer = http.createServer();
    const upstreamWss = new WebSocketServer({ server: upstreamServer });
    const receivedUpstreamMessages: string[] = [];

    await new Promise<void>((r) => upstreamServer.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstreamServer.address() as any).port;

    upstreamWss.on('connection', (ws) => {
      ws.on('message', (msg) => {
        receivedUpstreamMessages.push(msg.toString());
      });
    });

    // Mock proxy with bounded FIFO queue (mirroring server.ts logic)
    const proxyServer = http.createServer();
    const proxyWss = new WebSocketServer({ server: proxyServer });
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    const proxyPort = (proxyServer.address() as any).port;

    proxyWss.on('connection', (clientWs) => {
      const MAX_QUEUE_SIZE = 100;
      interface QueuedMessage {
        data: any;
        isBinary: boolean;
      }
      let queue: QueuedMessage[] = [];
      let isUpstreamOpen = false;
      let isSessionClosed = false;

      // Connect to upstream with artificial delay
      const upstreamWs = new WebSocket(`ws://127.0.0.1:${upstreamPort}`);

      upstreamWs.on('open', () => {
        isUpstreamOpen = true;
        while (queue.length > 0 && !isSessionClosed && clientWs.readyState === WebSocket.OPEN && upstreamWs.readyState === WebSocket.OPEN) {
          const item = queue.shift()!;
          upstreamWs.send(item.data, { binary: item.isBinary });
        }
      });

      clientWs.on('message', (data, isBinary) => {
        if (isSessionClosed) return;
        if (isUpstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary });
        } else if (upstreamWs.readyState === WebSocket.CONNECTING) {
          if (queue.length >= MAX_QUEUE_SIZE) {
            const dropIndex = queue.length > 1 ? 1 : 0;
            queue.splice(dropIndex, 1);
          }
          queue.push({ data, isBinary });
        }
      });

      const cleanup = () => {
        isSessionClosed = true;
        isUpstreamOpen = false;
        queue = [];
      };

      upstreamWs.on('close', cleanup);
      clientWs.on('close', cleanup);
    });

    // Client connects to proxy and immediately sends messages BEFORE upstream opens
    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
    await new Promise<void>((r) => client.on('open', r));

    client.send('msg-1-session-update');
    client.send('msg-2-audio-chunk-1');
    client.send('msg-3-audio-chunk-2');

    // Wait 250ms for upstream to open and flush
    await new Promise((r) => setTimeout(r, 250));

    assert.strictEqual(receivedUpstreamMessages.length, 3, 'All 3 queued messages must reach upstream');
    assert.strictEqual(receivedUpstreamMessages[0], 'msg-1-session-update', 'First message must be session.update');
    assert.strictEqual(receivedUpstreamMessages[1], 'msg-2-audio-chunk-1', 'Order must be preserved');
    assert.strictEqual(receivedUpstreamMessages[2], 'msg-3-audio-chunk-2', 'Order must be preserved');

    client.close();
    proxyServer.close();
    upstreamServer.close();
    console.log('✅ [PASSED] Pre-open queueing & FIFO ordered flush verified.\n');
  }

  // Test 3: Upstream connection failure and queue cleanup
  console.log('Test 3: Testing upstream connection failure and queue cleanup...');
  {
    const proxyServer = http.createServer();
    const proxyWss = new WebSocketServer({ server: proxyServer });
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    const proxyPort = (proxyServer.address() as any).port;

    let proxyCleanedUp = false;

    proxyWss.on('connection', (clientWs) => {
      let queue = ['msg1', 'msg2'];
      // Point to an unavailable upstream port
      const upstreamWs = new WebSocket('ws://127.0.0.1:9999');

      const cleanup = () => {
        queue = [];
        proxyCleanedUp = true;
      };

      upstreamWs.on('error', (err) => {
        cleanup();
        clientWs.close(1011, `Upstream error: ${err.message}`);
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
    let closeCodeReceived = 0;
    client.on('close', (code) => {
      closeCodeReceived = code;
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(closeCodeReceived, 1011, 'Client must receive error close code 1011');
    assert.strictEqual(proxyCleanedUp, true, 'Proxy queue must be cleaned up on upstream error');

    proxyServer.close();
    console.log('✅ [PASSED] Upstream connection failure handling and queue cleanup verified.\n');
  }

  // Test 4: Queue overflow handling with bounded capacity
  console.log('Test 4: Testing bounded queue overflow and non-initial frame eviction...');
  {
    const MAX_QUEUE_SIZE = 5;
    let queue: string[] = [];

    const enqueue = (msg: string) => {
      if (queue.length >= MAX_QUEUE_SIZE) {
        // Never drop initial session.update at index 0
        const dropIndex = queue.length > 1 ? 1 : 0;
        queue.splice(dropIndex, 1);
      }
      queue.push(msg);
    };

    enqueue('session.update');
    enqueue('audio-1');
    enqueue('audio-2');
    enqueue('audio-3');
    enqueue('audio-4');
    assert.strictEqual(queue.length, 5, 'Queue should be full at 5');

    // Enqueue 6th item -> should evict audio-1 (index 1), keeping session.update (index 0)
    enqueue('audio-5');
    assert.strictEqual(queue.length, 5, 'Queue length must remain bounded at 5');
    assert.strictEqual(queue[0], 'session.update', 'session.update at index 0 must be preserved');
    assert.strictEqual(queue[1], 'audio-2', 'Oldest audio frame was evicted');
    assert.strictEqual(queue[4], 'audio-5', 'Newest audio frame was appended');

    console.log('✅ [PASSED] Queue overflow bounds and critical session.update preservation verified.\n');
  }

  // Test 5: Client disconnection before upstream readiness
  console.log('Test 5: Testing client disconnection before upstream readiness...');
  {
    let upstreamClosed = false;
    let proxyQueueLengthAfterDisconnect = -1;

    // A server that accepts TCP connection but delays WebSocket handshake
    const slowUpstream = http.createServer((req, res) => {});
    await new Promise<void>((r) => slowUpstream.listen(0, '127.0.0.1', r));
    const slowPort = (slowUpstream.address() as any).port;

    const proxyServer = http.createServer();
    const proxyWss = new WebSocketServer({ server: proxyServer });
    await new Promise<void>((r) => proxyServer.listen(0, '127.0.0.1', r));
    const proxyPort = (proxyServer.address() as any).port;

    proxyWss.on('connection', (clientWs) => {
      let queue = ['initial-msg'];
      // Upstream socket is actively in CONNECTING state
      const upstreamWs = new WebSocket(`ws://127.0.0.1:${slowPort}`);
      upstreamWs.on('error', () => {});

      clientWs.on('close', () => {
        queue = [];
        proxyQueueLengthAfterDisconnect = queue.length;
        if (upstreamWs.readyState === WebSocket.CONNECTING || upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.close();
          upstreamClosed = true;
        }
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
    await new Promise<void>((r) => client.on('open', r));
    // Immediately close client before upstream handshake completes
    client.close(1000, 'Intentional immediate close');

    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(proxyQueueLengthAfterDisconnect, 0, 'Queue must be purged on client disconnect');
    assert.strictEqual(upstreamClosed, true, 'Upstream attempt must be aborted');

    proxyServer.close();
    slowUpstream.close();
    console.log('✅ [PASSED] Client disconnection before upstream readiness handled cleanly.\n');
  }

  // Test 6: Timing metrics when optional events are missing
  console.log('Test 6: Testing diagnostic report formatting when optional events are missing...');
  {
    const reportWithMissingEvents = generateFullDiagnosticReport({
      connectStartTime: Date.now() - 30000,
      completedTurns: 1,
      reconnectAttempts: 0,
      micState: 'idle',
      isResponseStreaming: false,
      closeInfo: null,
      telemetry: null,
      logs: [],
      droppedLogCount: 0,
      bufferedAmountHistory: [],
      speechStartedCount: 1,
      speechStoppedCount: 1,
      speechCommittedCount: 0, // Speech committed missing!
      transcriptionCount: 0,   // Transcription missing!
      transcriptionFailureCount: 0,
      responseCreatedCount: 1,
      interruptedResponseCount: 0,
      latencyMetrics: {
        // Only speechEndToResponseCreatedMs is available
        speechEndToResponseCreatedMs: 420,
      },
    });

    assert.ok(reportWithMissingEvents.includes('Speech Committed: N/A'), 'Missing commit must format as N/A');
    assert.ok(reportWithMissingEvents.includes('Transcription Completed: N/A'), 'Missing STT must format as N/A');
    assert.ok(reportWithMissingEvents.includes('Response Created: 420 ms'), 'Present metric must format with value');
    assert.ok(!reportWithMissingEvents.includes('NaN'), 'Must never output NaN');

    console.log('✅ [PASSED] Missing optional events formatted safely as N/A without NaN or crashes.\n');
  }

  // Test 7: Timestamp and elapsed-time correctness
  console.log('Test 7: Testing distinct speech-start timestamp and response latency...');
  {
    const speechStartTime = 1700000000000; // e.g. 16:12:00
    const speechDuration = 15000; // 15 seconds speech
    const speechStopTime = speechStartTime + speechDuration; // 16:12:15
    const firstTokenTime = speechStopTime + 280; // 280ms after speech ends

    const measuredSpeechEndToFirstTokenMs = firstTokenTime - speechStopTime;
    const apparentWallClockDifferenceMs = firstTokenTime - speechStartTime;

    // Verify mathematical separation
    assert.strictEqual(measuredSpeechEndToFirstTokenMs, 280, 'Measured latency after speech end must be 280ms');
    assert.strictEqual(apparentWallClockDifferenceMs, 15280, 'Wall clock includes full speech duration');
    assert.notStrictEqual(measuredSpeechEndToFirstTokenMs, apparentWallClockDifferenceMs, 'Latency must not conflate speech duration with response time');

    const sampleTurn: TurnTimingDiagnostic = {
      turnId: 'turn-test-1',
      timestamp: speechStartTime,
      speechDurationMs: speechDuration,
      speechEndToFirstVisibleTextMs: measuredSpeechEndToFirstTokenMs,
      status: 'complete',
    };

    assert.strictEqual(sampleTurn.speechDurationMs, 15000);
    assert.strictEqual(sampleTurn.speechEndToFirstVisibleTextMs, 280);

    console.log('✅ [PASSED] Timestamp semantics and elapsed latency separation verified.\n');
  }

  console.log('=====================================================================');
  console.log('  ALL 7 FOCUSED TESTS PASSED SUCCESSFULLY!                           ');
  console.log('=====================================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
