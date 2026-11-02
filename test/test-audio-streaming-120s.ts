import dotenv from 'dotenv';
import WebSocket from 'ws';
import { loadApiKey, mintEphemeralToken } from '../server';
import { buildSessionConfig } from '../src/realtime/events';

dotenv.config();

async function testAudioOnly() {
  console.log('=== TESTING CONTINUOUS AUDIO APPEND STREAMING FOR 120s ===');
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('No BOSON_API_KEY!');
    process.exit(1);
  }

  const token = await mintEphemeralToken(apiKey, 600);
  const wsUrl = 'wss://api.boson.ai/v1/realtime?model=higgs-realtime';

  const ws = new WebSocket(wsUrl, ['realtime', `bai-client-secret.${token.value}`]);
  const startTime = Date.now();

  let appendCount = 0;
  let serverPings = 0;

  ws.on('open', () => {
    console.log(`[${Date.now() - startTime}ms] OPEN -> Sending session.update`);
    ws.send(JSON.stringify(buildSessionConfig()));

    // Stream audio chunk every 100ms continuously (NO client ws.ping())
    const silenceB64 = Buffer.alloc(4800).toString('base64');
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        appendCount++;
        ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: silenceB64,
        }));
        if (appendCount % 100 === 0) {
          console.log(`[${Date.now() - startTime}ms] Streamed ${appendCount} chunks (~${(appendCount * 0.1).toFixed(1)}s)`);
        }
      } else {
        clearInterval(timer);
      }
    }, 100);
  });

  ws.on('ping', (data) => {
    serverPings++;
    console.log(`[${Date.now() - startTime}ms] Server Ping #${serverPings} received`);
  });

  ws.on('message', (data) => {
    const str = data.toString();
    try {
      const json = JSON.parse(str);
      if (json.type !== 'input_audio_buffer.speech_started' && json.type !== 'input_audio_buffer.speech_stopped') {
        console.log(`[${Date.now() - startTime}ms] RECV JSON: type=${json.type}`);
      }
    } catch {
      // ignore
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[${Date.now() - startTime}ms] WS CLOSED: code=${code}, reason="${reason.toString()}"`);
    process.exit(0);
  });

  setTimeout(() => {
    console.log(`[${Date.now() - startTime}ms] 120s test complete cleanly.`);
    ws.close(1000, 'Done');
    process.exit(0);
  }, 120000);
}

testAudioOnly().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
