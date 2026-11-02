export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'closing'
  | 'error';

export interface ServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export interface ClientEvent {
  type: string;
  [key: string]: unknown;
}

export interface ClientTelemetry {
  connectStartTime: number;
  uptimeMs: number;
  completedTurns: number;
  lastInboundTimestamp: number;
  lastInboundType: string;
  lastOutboundTimestamp: number;
  lastOutboundType: string;
  lastAudioAppendTimestamp: number;
  audioAppendCount: number;
  bufferedAmount: number;
  isMicActive: boolean;
  isResponseStreaming: boolean;
  timeSinceLastInboundMs: number;
  timeSinceLastOutboundMs: number;
}

export interface CloseInfo {
  code: number;
  reason: string;
  message: string;
  retryable: boolean;
  wasClean?: boolean;
  telemetry?: ClientTelemetry;
}

export type MicState = 'idle' | 'requesting' | 'recording' | 'error';

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status: 'streaming' | 'complete' | 'error' | 'interrupted';
  inputMode?: 'mic' | 'text';
  timestamp: number;
  speechDurationMs?: number;
  speechEndedTimestamp?: number;
  latencyAfterSpeechEndedMs?: number;
}

export interface TurnTimingDiagnostic {
  turnId: string;
  itemId?: string;
  timestamp: number;
  speechDurationMs?: number;
  speechEndToCommittedMs?: number;
  committedToTranscriptionMs?: number;
  speechEndToResponseCreatedMs?: number;
  responseCreatedToFirstDeltaMs?: number;
  firstDeltaToFirstRenderMs?: number;
  speechEndToFirstVisibleTextMs?: number;
  firstDeltaToFinalTextMs?: number;
  status: 'streaming' | 'complete' | 'interrupted';
  transcriptPreview?: string;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  direction: 'send' | 'recv' | 'info';
  type: string;
  payload: unknown;
  rawJson?: string;
}

export interface EphemeralTokenInfo {
  value: string;
  expires_at: number;
  obtained_at: number;
}

export interface BackendStatusInfo {
  status: string;
  hasApiKey: boolean;
  keyPrefix: string | null;
  bosonBaseUrl: string;
  model: string;
  enforcedModality: string[];
  serverTime: string;
}
