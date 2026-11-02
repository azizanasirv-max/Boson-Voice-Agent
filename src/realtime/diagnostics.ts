import type { CloseInfo, LogEntry, ClientTelemetry, TurnTimingDiagnostic } from './types';

export interface ExtendedDiagnosticsData {
  sessionId?: string;
  connectStartTime: number;
  disconnectTime?: number;
  completedTurns: number;
  reconnectAttempts: number;
  micState: string;
  isResponseStreaming: boolean;
  closeInfo: CloseInfo | null;
  telemetry: ClientTelemetry | null;
  logs: LogEntry[];
  droppedLogCount: number;
  bufferedAmountHistory: { timestamp: number; bytes: number }[];
  speechStartedCount: number;
  speechStoppedCount: number;
  speechCommittedCount: number;
  transcriptionCount: number;
  transcriptionFailureCount: number;
  responseCreatedCount: number;
  interruptedResponseCount: number;
  lastResponseTimestamps?: {
    created?: number;
    firstDelta?: number;
    textDone?: number;
    responseDone?: number;
  };
  customInstructions?: string;
  latencyMetrics?: {
    speechEndToCommittedMs?: number;
    committedToTranscriptionMs?: number;
    speechEndToResponseCreatedMs?: number;
    responseCreatedToFirstDeltaMs?: number;
    firstDeltaToFirstRenderMs?: number;
    speechEndToFirstVisibleTextMs?: number;
    firstDeltaToFinalTextMs?: number;
  };
  turnHistory?: TurnTimingDiagnostic[];
}

/**
 * Redacts API keys, ephemeral tokens, and secret strings from diagnostic payload object or text.
 */
export function redactSecrets(input: unknown): unknown {
  if (typeof input === 'string') {
    return input
      .replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [REDACTED_SECRET]')
      .replace(/bai-[A-Za-z0-9_.-]+/g, '[REDACTED_TOKEN]')
      .replace(/bos[_-]?key[_-]?[A-Za-z0-9_.-]+/gi, '[REDACTED_KEY]')
      .replace(/(api[_-]?key|secret|token|key)\s*[:=\s]\s*["']?[A-Za-z0-9_.-]+["']?/gi, '$1: "[REDACTED_SECRET]"');
  }

  if (Array.isArray(input)) {
    return input.map(redactSecrets);
  }

  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('secret') ||
        lowerKey.includes('apikey') ||
        lowerKey.includes('token') ||
        lowerKey.includes('authorization') ||
        lowerKey.includes('password')
      ) {
        result[key] = '[REDACTED_SECRET]';
      } else {
        result[key] = redactSecrets(value);
      }
    }
    return result;
  }

  return input;
}

/**
 * Generates a full, human-readable structured diagnostic report formatted for ChatGPT debugging.
 */
export function generateFullDiagnosticReport(data: ExtendedDiagnosticsData): string {
  const now = Date.now();
  const startTimeStr = data.connectStartTime > 0 ? new Date(data.connectStartTime).toISOString() : 'N/A';
  const endTimeStr = data.disconnectTime ? new Date(data.disconnectTime).toISOString() : 'Active Session';
  const uptimeSec = data.connectStartTime > 0
    ? (((data.disconnectTime || now) - data.connectStartTime) / 1000).toFixed(1)
    : '0';

  const telemetry = data.telemetry || data.closeInfo?.telemetry;

  // Calculate last response durations if available
  let firstTokenLatencyStr = 'unavailable';
  let responseDurationStr = 'unavailable';
  if (data.lastResponseTimestamps?.created) {
    const c = data.lastResponseTimestamps.created;
    if (data.lastResponseTimestamps.firstDelta) {
      firstTokenLatencyStr = `${data.lastResponseTimestamps.firstDelta - c} ms`;
    }
    if (data.lastResponseTimestamps.responseDone) {
      responseDurationStr = `${data.lastResponseTimestamps.responseDone - c} ms`;
    }
  }

  // Format bufferedAmount history
  const recentBufferStr = data.bufferedAmountHistory.length > 0
    ? data.bufferedAmountHistory
        .slice(-8)
        .map((b) => `${new Date(b.timestamp).toLocaleTimeString([], { second: '2-digit' })}:${b.bytes}B`)
        .join(', ')
    : 'None recorded';

  // Section 1: Session Summary
  let report = `=== SESSION SUMMARY ===
Session Identifier: ${data.sessionId || 'boson-realtime-' + data.connectStartTime}
Session Start: ${startTimeStr}
Session End: ${endTimeStr}
Connection Uptime: ${uptimeSec}s
Completed Customer Turns: ${data.completedTurns}
Reconnect Attempts: ${data.reconnectAttempts}
Microphone State: ${data.micState}
Response Generation State: ${data.isResponseStreaming ? 'Active (streaming)' : 'Idle'}

`;

  // Section 2: WebSocket Closure
  report += `=== WEBSOCKET CLOSURE ===
Close Code: ${data.closeInfo ? data.closeInfo.code : 'N/A (Connected/Clean)'}
Close Reason: ${data.closeInfo ? data.closeInfo.reason || 'None specified' : 'N/A'}
wasClean: ${data.closeInfo && data.closeInfo.wasClean !== undefined ? data.closeInfo.wasClean : 'N/A'}
Last Inbound Timestamp: ${telemetry && telemetry.lastInboundTimestamp > 0 ? new Date(telemetry.lastInboundTimestamp).toISOString() : 'N/A'}
Last Inbound Event Type: ${telemetry?.lastInboundType || 'N/A'}
Time Since Last Inbound Activity: ${telemetry && telemetry.timeSinceLastInboundMs >= 0 ? `${telemetry.timeSinceLastInboundMs} ms` : 'N/A'}
Last Outbound Timestamp: ${telemetry && telemetry.lastOutboundTimestamp > 0 ? new Date(telemetry.lastOutboundTimestamp).toISOString() : 'N/A'}
Last Outbound Event Type: ${telemetry?.lastOutboundType || 'N/A'}
Time Since Last Outbound Activity: ${telemetry && telemetry.timeSinceLastOutboundMs >= 0 ? `${telemetry.timeSinceLastOutboundMs} ms` : 'N/A'}
bufferedAmount at Closure: ${telemetry ? `${telemetry.bufferedAmount} bytes` : 'N/A'}
Recent bufferedAmount Samples: ${recentBufferStr}
Connection Uptime at Closure: ${uptimeSec}s

`;

  // Section 3: Audio and VAD
  const chunkRate = telemetry && telemetry.uptimeMs > 1000
    ? (telemetry.audioAppendCount / (telemetry.uptimeMs / 1000)).toFixed(1)
    : '0';

  report += `=== AUDIO AND VAD ===
Audio Append Count: ${telemetry?.audioAppendCount ?? 0}
Audio Chunk Rate: ${chunkRate} chunks/sec (~100ms frames)
Last Audio Append Timestamp: ${telemetry && telemetry.lastAudioAppendTimestamp > 0 ? new Date(telemetry.lastAudioAppendTimestamp).toISOString() : 'N/A'}
Audio Configuration: 24000 Hz, mono PCM16, turn_detection: server_vad
Speech Started Events: ${data.speechStartedCount}
Speech Stopped Events: ${data.speechStoppedCount}
Speech Committed Events: ${data.speechCommittedCount}
Transcription Completions: ${data.transcriptionCount}
Transcription Failures: ${data.transcriptionFailureCount}

`;

  // Section 4: Response Lifecycle
  report += `=== RESPONSE LIFECYCLE ===
Responses Created: ${data.responseCreatedCount}
First Text Delta Timestamp: ${data.lastResponseTimestamps?.firstDelta ? new Date(data.lastResponseTimestamps.firstDelta).toISOString() : 'unavailable'}
Text Completion Timestamp: ${data.lastResponseTimestamps?.textDone ? new Date(data.lastResponseTimestamps.textDone).toISOString() : 'unavailable'}
Response Completion Timestamp: ${data.lastResponseTimestamps?.responseDone ? new Date(data.lastResponseTimestamps.responseDone).toISOString() : 'unavailable'}
Last First-Token Latency: ${firstTokenLatencyStr}
Last Total Response Duration: ${responseDurationStr}
Interrupted Responses Count: ${data.interruptedResponseCount}

`;

  // Section 4.1: Latency Performance Breakdown
  const lm = data.latencyMetrics || {};
  report += `=== LATENCY PERFORMANCE BREAKDOWN ===
Latest Turn Metrics:
- Speech End → Speech Committed: ${lm.speechEndToCommittedMs !== undefined ? `${lm.speechEndToCommittedMs} ms` : 'N/A'}
- Speech Committed → Transcription Completed: ${lm.committedToTranscriptionMs !== undefined ? `${lm.committedToTranscriptionMs} ms` : 'N/A'}
- Speech End → Response Created: ${lm.speechEndToResponseCreatedMs !== undefined ? `${lm.speechEndToResponseCreatedMs} ms` : 'N/A'}
- Response Created → First Text Delta: ${lm.responseCreatedToFirstDeltaMs !== undefined ? `${lm.responseCreatedToFirstDeltaMs} ms` : 'N/A'}
- First Delta → UI Render: ${lm.firstDeltaToFirstRenderMs !== undefined ? `${lm.firstDeltaToFirstRenderMs} ms` : 'N/A'}
- Speech End → First Visible Text (Total Latency): ${lm.speechEndToFirstVisibleTextMs !== undefined ? `${lm.speechEndToFirstVisibleTextMs} ms` : 'N/A'}
- First Delta → Final Text: ${lm.firstDeltaToFinalTextMs !== undefined ? `${lm.firstDeltaToFinalTextMs} ms` : 'N/A'}
`;

  if (data.turnHistory && data.turnHistory.length > 0) {
    const validTtft = data.turnHistory
      .map((t) => t.speechEndToFirstVisibleTextMs)
      .filter((v): v is number => typeof v === 'number' && !isNaN(v));
    const avgTtft = validTtft.length > 0 ? Math.round(validTtft.reduce((a, b) => a + b, 0) / validTtft.length) : 'N/A';
    const minTtft = validTtft.length > 0 ? Math.min(...validTtft) : 'N/A';
    const maxTtft = validTtft.length > 0 ? Math.max(...validTtft) : 'N/A';

    report += `\nMulti-Turn History Summary (${data.turnHistory.length} turns recorded):
- Average Speech-End-to-First-Token: ${typeof avgTtft === 'number' ? `${avgTtft} ms` : avgTtft}
- Fastest First-Token: ${typeof minTtft === 'number' ? `${minTtft} ms` : minTtft}
- Slowest First-Token: ${typeof maxTtft === 'number' ? `${maxTtft} ms` : maxTtft}

Recent Turn Logs:
`;
    const recent = data.turnHistory.slice(-10);
    for (const t of recent) {
      const durStr = t.speechDurationMs !== undefined ? `${(t.speechDurationMs / 1000).toFixed(1)}s` : 'N/A';
      const ttftStr = t.speechEndToFirstVisibleTextMs !== undefined ? `${t.speechEndToFirstVisibleTextMs} ms` : 'N/A';
      const sttStr = t.committedToTranscriptionMs !== undefined ? `${t.committedToTranscriptionMs} ms` : 'N/A';
      report += `  • Turn ${t.turnId}: Speech Duration=${durStr}, TTFT=${ttftStr}, STT Latency=${sttStr}, Status=${t.status}\n`;
    }
  }

  report += '\n';

  // Section 5: Chronological Event Log
  report += `=== CHRONOLOGICAL EVENT LOG ===\n`;
  if (data.logs.length === 0) {
    report += `(No event logs recorded)\n`;
  } else {
    for (const log of data.logs) {
      const timeStr = new Date(log.timestamp).toISOString();
      const redactedPayload = redactSecrets(log.payload);
      let payloadStr = '';
      try {
        payloadStr = typeof redactedPayload === 'object' ? JSON.stringify(redactedPayload) : String(redactedPayload);
      } catch {
        payloadStr = '[Complex Payload]';
      }
      report += `[${timeStr}] [${log.direction.toUpperCase()}] ${log.type} ${payloadStr}\n`;
    }
  }

  // Section 6: Diagnostic Limitations
  report += `\n=== DIAGNOSTIC LIMITATIONS ===
- Protocol-level Ping/Pong frames are managed by browser C++ networking stack and unavailable in JS APIs.
- Raw Base64 audio payloads are omitted from log buffers to conserve browser memory and protect privacy.
- Retained Event Logs: ${data.logs.length} entries.
- Dropped/Truncated Event Logs: ${data.droppedLogCount} entries.
`;

  return report;
}
