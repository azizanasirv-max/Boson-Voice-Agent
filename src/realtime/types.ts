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

export type MicState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'muted'
  | 'denied'
  | 'unavailable'
  | 'disconnected'
  | 'error';

/**
 * Live microphone health. `flowing` is the only trustworthy signal that audio is
 * actually reaching the provider: it is driven by frames arriving from the
 * AudioWorklet, not by the intent to record.
 */
export interface MicHealth {
  state: MicState;
  /** Human-readable reason for non-recording states. */
  detail?: string;
  /** Device label from the active MediaStreamTrack, when the browser exposes it. */
  deviceLabel?: string;
  /** Frames received from the capture worklet since start. */
  frameCount: number;
  /** Frames produced but discarded because the socket was not writable. */
  framesDropped: number;
  /** Date.now() of the most recent capture frame (0 when none yet). */
  lastFrameAt: number;
  /** True when frames are arriving recently enough to be considered live audio. */
  flowing: boolean;
}

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
  /** Speech end -> first delta actually painted by the browser (measured render). */
  speechEndToFirstRenderMs?: number;
  firstDeltaToFinalTextMs?: number;
  /** Name of the stage that consumed the most time within this turn. */
  slowestStage?: string;
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
