import dotenv from 'dotenv';
import WebSocket from 'ws';
import { loadApiKey, mintEphemeralToken } from '../server';
import { buildSessionConfig } from '../src/realtime/events';

dotenv.config();

async function runKeepaliveTest() {
  console.log('=== STARTING BOSON KEEPALIVE TIMEOUT INVESTIGATION ===');
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('No BOSON_API_KEY found!');
    process.exit(1);
  }

  const token = await mintEphemeralToken(apiKey, 600);
  const wsUrl = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';

  console.log('Connecting to Boson WebSocket...');
  const ws = new WebSocket(wsUrl, ['realtime', `bai-client-secret.${token.value}`]);
  const startTime = Date.now();

  let pingsSentByClient = 0;
  let pingsReceivedFromServer = 0;

  ws.on('open', () => {
    console.log(`[${Date.now() - startTime}ms] Connected. Sending session.update`);
    ws.send(JSON.stringify(buildSessionConfig()));

    // Schedule client-initiated WebSocket Ping every 15 seconds
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        pingsSentByClient++;
        console.log(`[${Date.now() - startTime}ms] Sending client WS PING #${pingsSentByClient}`);
        ws.ping(); // Sends opcode 0x9 Ping frame from client
      } else {
        clearInterval(pingInterval);
      }
    }, 15000);
  });

  ws.on('ping', (data) => {
    pingsReceivedFromServer++;
    console.log(`[${Date.now() - startTime}ms] Server sent WS PING #${pingsReceivedFromServer} (payload: ${data.toString('hex') || 'empty'})`);
    // 'ws' library automatically sends Pong response
  });

  ws.on('pong', (data) => {
    console.log(`[${Date.now() - startTime}ms] Server responded with WS PONG to our client Ping!`);
  });

  ws.on('message', (data) => {
    try {
      const json = JSON.parse(data.toString());
      console.log(`[${Date.now() - startTime}ms] RECV JSON: type=${json.type}`);
    } catch {
      console.log(`[${Date.now() - startTime}ms] RECV TEXT: ${data.toString().slice(0, 50)}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[${Date.now() - startTime}ms] WS CLOSED: code=${code}, reason="${reason.toString()}"`);
    process.exit(0);
  });

  // Keep test alive for 150s (longer than the 100s failure point)
  setTimeout(() => {
    console.log(`[${Date.now() - startTime}ms] 150s Test completed cleanly without 1011 timeout!`);
    ws.close(1000, 'Test completed');
    process.exit(0);
  }, 150000);
}

runKeepaliveTest().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
