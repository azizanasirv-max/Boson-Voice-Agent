import dotenv from 'dotenv';
import WebSocket from 'ws';
import { loadApiKey, mintEphemeralToken } from '../server';
import { buildSessionConfig } from '../src/realtime/events';

dotenv.config();

async function runDiagnosis() {
  console.log('=== STARTING BOSON WEBSOCKET DIAGNOSIS ===');
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('No BOSON_API_KEY found!');
    process.exit(1);
  }

  const token = await mintEphemeralToken(apiKey, 600);
  console.log('Minted token:', token.value.slice(0, 15), 'expires_at:', token.expires_at);

  const wsUrl = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';
  console.log('Connecting to:', wsUrl);

  const ws = new WebSocket(wsUrl, ['realtime', `bai-client-secret.${token.value}`]);

  const startTime = Date.now();

  ws.on('open', () => {
    console.log(`[${(Date.now() - startTime)}ms] WS OPEN`);
    const sessionConfig = buildSessionConfig();
    console.log(`[${(Date.now() - startTime)}ms] Sending session.update`);
    ws.send(JSON.stringify(sessionConfig));
  });

  // Listen to raw ping and pong control frames from Node.js 'ws' library!
  ws.on('ping', (data) => {
    console.log(`[${(Date.now() - startTime)}ms] RAW WS PING RECEIVED from server! Payload:`, data.toString('hex') || '(empty)');
  });

  ws.on('pong', (data) => {
    console.log(`[${(Date.now() - startTime)}ms] RAW WS PONG RECEIVED from server! Payload:`, data.toString('hex') || '(empty)');
  });

  ws.on('message', (data) => {
    const str = data.toString();
    try {
      const json = JSON.parse(str);
      console.log(`[${(Date.now() - startTime)}ms] RECV JSON: type=${json.type}`);
    } catch {
      console.log(`[${(Date.now() - startTime)}ms] RECV TEXT (unparseable):`, str.slice(0, 100));
    }
  });

  ws.on('error', (err) => {
    console.error(`[${(Date.now() - startTime)}ms] WS ERROR:`, err);
  });

  ws.on('close', (code, reason) => {
    console.log(`[${(Date.now() - startTime)}ms] WS CLOSE: code=${code}, reason="${reason.toString()}"`);
    process.exit(0);
  });

  // Stream dummy audio chunks every 100ms like the browser microphone does
  const silenceB64 = Buffer.alloc(4800).toString('base64'); // 2400 samples of Int16 PCM = 100ms
  let appendCount = 0;

  const audioInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      appendCount++;
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: silenceB64,
      }));
      if (appendCount % 50 === 0) {
        console.log(`[${(Date.now() - startTime)}ms] Sent ${appendCount} audio chunks (~${(appendCount * 0.1).toFixed(1)}s)`);
      }
    } else {
      clearInterval(audioInterval);
    }
  }, 100);

  // Keep running for up to 120 seconds to observe any keepalive timeout!
  setTimeout(() => {
    console.log('120s timeout reached, closing WS cleanly.');
    ws.close(1000, 'Test completed');
  }, 120000);
}

runDiagnosis().catch((err) => {
  console.error('Diagnosis failed:', err);
  process.exit(1);
});
