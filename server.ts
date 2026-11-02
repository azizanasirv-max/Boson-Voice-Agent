import express, { type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOSON_BASE_URL = (process.env.BOSON_BASE_URL || 'https://api.boson.ai').replace(/\/+$/, '');

export function resolveServerPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (process.env.APP_PORT) {
    const parsed = parseInt(process.env.APP_PORT, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (process.env.PORT) {
    const parsed = parseInt(process.env.PORT, 10);
    // In this container deployment, Nginx is listening on 8080 and proxies to 3000.
    // If PORT=8080 is injected for the container gateway, the Node app must listen on 3000.
    if (!isNaN(parsed) && parsed > 0 && parsed !== 8080) return parsed;
  }
  return 3000;
}

const PORT = resolveServerPort();
const isProduction = process.env.NODE_ENV === 'production';

/**
 * Safely loads the permanent Boson API key from the server environment.
 * Checks inline environment variable, followed by an optional key file path.
 */
export function loadApiKey(): string | undefined {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;

  const keyFile = process.env.BOSON_API_KEY_FILE?.trim();
  if (keyFile) {
    try {
      if (fs.existsSync(keyFile)) {
        const fromFile = fs.readFileSync(keyFile, 'utf8').trim();
        if (fromFile) return fromFile;
      }
    } catch {
      // Ignore file read error and fall through
    }
  }

  return undefined;
}

/**
 * Mints an ephemeral client secret via Boson AI's client_secrets endpoint.
 * This function communicates strictly server-to-server using Authorization: Bearer.
 */
export async function mintEphemeralToken(apiKey: string, expiresInSeconds = 600): Promise<{ value: string; expires_at: number }> {
  const targetUrl = `${BOSON_BASE_URL}/v1/realtime/client_secrets`;
  
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expires_after: {
        seconds: Math.max(10, Math.min(7200, expiresInSeconds)),
      },
    }),
  });

  const responseText = await response.text();
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`Invalid JSON response from Boson (${response.status}): ${responseText.slice(0, 100)}`);
  }

  if (!response.ok) {
    const errorMsg = data?.detail || data?.error?.message || data?.error || `HTTP ${response.status}`;
    const err = new Error(`Boson client_secrets failed [${response.status}]: ${errorMsg}`);
    (err as any).statusCode = response.status;
    (err as any).upstreamData = data;
    throw err;
  }

  // Expect { value: "bai-eph-...", expires_at: 17... }
  const value = data.value || data.client_secret?.value || data.client_secret;
  const expiresAt = data.expires_at || data.client_secret?.expires_at;

  if (!value) {
    throw new Error('Upstream response missing ephemeral token value');
  }

  return {
    value,
    expires_at: typeof expiresAt === 'number' ? expiresAt : Math.floor(Date.now() / 1000) + expiresInSeconds,
  };
}

export function createExpressApp() {
  const app = express();
  app.use(express.json());

  // Health and backend status check (safe - no secrets exposed)
  app.get('/api/status', (_req: Request, res: Response) => {
    const key = loadApiKey();
    const hasKey = Boolean(key && key.length > 0);
    const maskedPrefix = hasKey ? `${key!.slice(0, 7)}...` : null;

    res.json({
      status: 'ok',
      hasApiKey: hasKey,
      keyPrefix: maskedPrefix,
      bosonBaseUrl: BOSON_BASE_URL,
      model: 'higgs-realtime',
      enforcedModality: ['text'],
      serverTime: new Date().toISOString(),
    });
  });

  // Ephemeral client secret minting endpoint
  app.get('/api/token', async (_req: Request, res: Response) => {
    const apiKey = loadApiKey();
    if (!apiKey) {
      return res.status(500).json({
        error: 'BOSON_API_KEY is not configured in the server environment.',
        help: 'Please set BOSON_API_KEY in your environment or .env file.',
        configured: false,
      });
    }

    try {
      const tokenData = await mintEphemeralToken(apiKey, 600);
      return res.json({
        value: tokenData.value,
        expires_at: tokenData.expires_at,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 500;
      console.error('[Boson Token Mint Error]:', error.message);
      return res.status(statusCode).json({
        error: error.message,
        statusCode,
      });
    }
  });

  return app;
}

/** At most 2 s of 50 ms audio frames may wait for the upstream socket to open. */
const MAX_PREOPEN_QUEUE = 40;

/** Ping interval for both legs; browsers answer ping frames automatically. */
const HEARTBEAT_INTERVAL_MS = 20000;

interface QueuedMessage {
  data: any;
  isBinary: boolean;
  receivedHr: bigint;
  /** Parsed `type` for text frames, 'binary' for binary frames. */
  kind: string;
}

/** Identifies a queued frame without trusting it: used only to choose drop order. */
function classifyMessage(data: any, isBinary: boolean): string {
  if (isBinary) return 'binary';
  try {
    const parsed = JSON.parse(String(data));
    return typeof parsed?.type === 'string' ? parsed.type : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Close codes a ws close frame may legally carry (1005/1006/1004/1015 are reserved). */
const RESERVED_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

/**
 * Maps a received close code onto one that is legal to SEND in a close frame.
 *
 * `ws` throws "First argument must be a valid error code number" for reserved
 * codes. Browsers routinely report 1005 (no status received) when a tab closes or
 * a socket dies, so forwarding it verbatim would throw inside the close handler
 * and crash the entire server process, dropping every other live session.
 */
export function sanitizeCloseCode(code: number, fallback = 1000): number {
  if (!Number.isFinite(code)) return fallback;
  if (code < 1000 || code > 4999) return fallback;
  if (RESERVED_CLOSE_CODES.has(code)) return fallback;
  if (code >= 1016 && code <= 2999) return fallback;
  return code;
}

/** Close reasons are capped at 123 bytes by the WebSocket spec. */
export function sanitizeCloseReason(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  const truncated = Buffer.from(reason, 'utf8').subarray(0, 123).toString('utf8');
  // Avoid emitting a broken multi-byte tail after truncation.
  return truncated.replace(/\uFFFD$/, '');
}

/**
 * Chooses which queued frame to discard when the pre-open queue overflows.
 *
 * Rules, in priority order:
 * 1. Never drop the first queued item (the initial session.update / auth handshake).
 * 2. Prefer dropping the oldest *audio append* — a gap in audio is survivable,
 *    a missing control event is not.
 * 3. Never drop from the middle of the queue: splicing audio corrupts the stream.
 */
export function selectDropIndex(queue: ReadonlyArray<{ kind: string }>): number {
  if (queue.length === 0) return -1;
  if (queue.length === 1) return 0;
  for (let i = 1; i < queue.length; i++) {
    if (queue[i].kind === 'input_audio_buffer.append') return i;
  }
  return 1;
}

/**
 * Attaches the Boson realtime WebSocket proxy to an HTTP server.
 * Exported so integration tests exercise the real implementation rather than a copy.
 */
export function attachRealtimeProxy(server: http.Server): WebSocketServer {
  // perMessageDeflate is disabled: permessage-deflate buffers frames before
  // flushing, which adds latency to every small audio append, and audio is
  // already encoded compactly.
  const wss = new WebSocketServer({ server, path: '/ws/realtime', perMessageDeflate: false });

  wss.on('connection', (clientWs, req) => {

    const maskedRemote = req.socket.remoteAddress || 'unknown';
    console.log('[WebSocket Proxy] Client connected from:', maskedRemote);

    // Extract ephemeral token from query parameters or subprotocols
    let token = '';
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      token = url.searchParams.get('token') || '';
    } catch {
      // ignore
    }

    if (!token) {
      const protocolHeader = req.headers['sec-websocket-protocol'] || '';
      const parts = protocolHeader.split(',').map((p) => p.trim());
      for (const p of parts) {
        if (p.startsWith('bai-client-secret.')) {
          token = p.replace('bai-client-secret.', '');
          break;
        }
      }
    }

    if (!token) {
      console.error('[WebSocket Proxy] Rejected connection: Missing ephemeral token');
      clientWs.close(4401, 'Missing ephemeral token');
      return;
    }

    const maskedToken = `${token.slice(0, 10)}...`;
    const bosonWsUrl = `${BOSON_BASE_URL.replace(/^http/, 'ws')}/v1/realtime?model=higgs-realtime`;
    console.log(`[WebSocket Proxy] Connecting upstream to Boson with token ${maskedToken}`);

    // Bounded pre-open queue that resolves the upstream readiness race without
    // ever corrupting the audio stream by removing frames from its middle.
    let preOpenQueue: QueuedMessage[] = [];
    let isUpstreamOpen = false;
    let isSessionClosed = false;
    let droppedFrames = 0;
    const forwardedCount = { text: 0 };
    const connStartHr = process.hrtime.bigint();

    const bosonWs = new NodeWebSocket(bosonWsUrl, ['realtime', `bai-client-secret.${token}`]);

    let upstreamAlive = true;
    let clientAlive = true;

    const heartbeat = setInterval(() => {
      if (isSessionClosed) return;

      if (bosonWs.readyState === NodeWebSocket.OPEN) {
        if (!upstreamAlive) {
          console.warn('[WebSocket Proxy] Upstream heartbeat lost; terminating stale socket.');
          try {
            bosonWs.terminate();
          } catch {
            // ignore
          }
          return;
        }
        upstreamAlive = false;
        try {
          bosonWs.ping();
        } catch {
          // ignore
        }
      }

      if (clientWs.readyState === NodeWebSocket.OPEN) {
        if (!clientAlive) {
          console.warn('[WebSocket Proxy] Client heartbeat lost; terminating stale socket.');
          try {
            clientWs.terminate();
          } catch {
            // ignore
          }
          return;
        }
        clientAlive = false;
        try {
          clientWs.ping();
        } catch {
          // ignore
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    bosonWs.on('pong', () => {
      upstreamAlive = true;
    });
    clientWs.on('pong', () => {
      clientAlive = true;
    });

    const cleanup = () => {
      isSessionClosed = true;
      isUpstreamOpen = false;
      preOpenQueue = [];
      clearInterval(heartbeat);
    };

    bosonWs.on('open', () => {
      isUpstreamOpen = true;
      upstreamAlive = true;
      const upstreamReadyHr = process.hrtime.bigint();
      const connectMs = Number(upstreamReadyHr - connStartHr) / 1e6;
      console.log(
        `[WebSocket Proxy] Upstream connection to Boson ready in ${connectMs.toFixed(1)}ms. Flushing ${preOpenQueue.length} queued messages in order.`
      );

      // Flush queued messages in original FIFO order
      while (
        preOpenQueue.length > 0 &&
        !isSessionClosed &&
        clientWs.readyState === NodeWebSocket.OPEN &&
        bosonWs.readyState === NodeWebSocket.OPEN
      ) {
        const item = preOpenQueue.shift()!;
        forwardedCount.text++;
        bosonWs.send(item.data, { binary: item.isBinary }, (err) => {
          if (err) {
            console.error('[WebSocket Proxy] Error during queue flush send:', err.message);
          }
        });
      }
    });

    bosonWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === NodeWebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    });

    clientWs.on('message', (data, isBinary) => {
      if (isSessionClosed) return;

      if (isUpstreamOpen && bosonWs.readyState === NodeWebSocket.OPEN) {
        forwardedCount.text++;
        bosonWs.send(data, { binary: isBinary }, (err) => {
          if (err) {
            console.error('[WebSocket Proxy] Error sending message to upstream:', err.message);
          }
        });
        return;
      }

      if (bosonWs.readyState === NodeWebSocket.CONNECTING) {
        if (preOpenQueue.length >= MAX_PREOPEN_QUEUE) {
          const dropIndex = selectDropIndex(preOpenQueue);
          if (dropIndex >= 0) {
            const [dropped] = preOpenQueue.splice(dropIndex, 1);
            if (dropped.kind === 'input_audio_buffer.append' || dropped.isBinary) droppedFrames++;
            console.warn(
              `[WebSocket Proxy] Pre-open queue full (${MAX_PREOPEN_QUEUE}); dropped oldest "${dropped.kind}" frame. Total audio frames dropped: ${droppedFrames}`
            );
          }
        }
        preOpenQueue.push({
          data,
          isBinary,
          receivedHr: process.hrtime.bigint(),
          kind: classifyMessage(data, isBinary),
        });
        return;
      }

      if (isBinary || classifyMessage(data, isBinary) === 'input_audio_buffer.append') {
        droppedFrames++;
      }
      console.warn(
        `[WebSocket Proxy] Upstream not available (state: ${bosonWs.readyState}). Discarding message safely. Total audio frames dropped: ${droppedFrames}`
      );
    });

    bosonWs.on('close', (code, reason) => {
      console.log(
        `[WebSocket Proxy] Upstream closed by Boson: code=${code}, reason="${reason.toString()}" (forwarded=${forwardedCount.text}, droppedAudioFrames=${droppedFrames})`
      );
      cleanup();
      if (clientWs.readyState === NodeWebSocket.OPEN) {
        // Sanitised: 1005/1006 cannot be echoed back in a close frame.
        clientWs.close(sanitizeCloseCode(code, 1000), sanitizeCloseReason(reason.toString()));
      }
    });

    clientWs.on('close', (code, reason) => {
      console.log(
        `[WebSocket Proxy] Client closed: code=${code}, reason="${reason.toString()}" (forwarded=${forwardedCount.text}, droppedAudioFrames=${droppedFrames})`
      );
      cleanup();
      if (bosonWs.readyState === NodeWebSocket.OPEN || bosonWs.readyState === NodeWebSocket.CONNECTING) {
        // Browsers report 1005 (no status) constantly; echoing it would throw and
        // crash the process, killing every other live session.
        bosonWs.close(sanitizeCloseCode(code, 1000), sanitizeCloseReason(reason.toString()));
      }
    });

    bosonWs.on('error', (err) => {
      console.error('[WebSocket Proxy] Upstream error from Boson:', err.message);
      cleanup();
      if (clientWs.readyState === NodeWebSocket.OPEN) {
        clientWs.close(1011, `Upstream error: ${err.message}`);
      }
    });

    clientWs.on('error', (err) => {
      console.error('[WebSocket Proxy] Client error:', err.message);
      cleanup();
      if (bosonWs.readyState === NodeWebSocket.OPEN || bosonWs.readyState === NodeWebSocket.CONNECTING) {
        bosonWs.close(1011, `Client error: ${err.message}`);
      }
    });
  });

  return wss;
}

async function startServer() {
  const app = createExpressApp();
  const server = http.createServer(app);

  attachRealtimeProxy(server);

  if (!isProduction) {

    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Boson Tester Server] listening on http://0.0.0.0:${PORT}`);
    console.log(`[Boson Tester Server] BOSON_BASE_URL: ${BOSON_BASE_URL}`);
    console.log(`[Boson Tester Server] API Key configured: ${Boolean(loadApiKey())}`);
  });
}

// Only start the server when run directly (not when imported in test scripts)
if (process.argv[1] && (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
