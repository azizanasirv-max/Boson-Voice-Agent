import { MicCapture, type MicCaptureCallbacks, type MicCaptureLike } from '../audio/capture';
import { generateFullDiagnosticReport, type ExtendedDiagnosticsData } from './diagnostics';
import {
  SERVER_EVENTS,
  buildSessionConfig,
  describeClose,
  inputAudioAppend,
  responseCreate,
  userTextItem,
  type VadConfig,
} from './events';
import type {
  ClientEvent,
  ClientTelemetry,
  CloseInfo,
  ConnectionStatus,
  ConversationMessage,
  EphemeralTokenInfo,
  LogEntry,
  MicHealth,
  MicState,
  ServerEvent,
  TurnTimingDiagnostic,
} from './types';

const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
const WS_BASE_URL = `${protocol}//${host}/ws/realtime`;

/** Upper bound on retained raw JSON per log entry (diagnostics stay readable). */
const MAX_RAW_LOG_CHARS = 2000;

export interface RealtimeClientOptions {
  onStatusChange?: (status: ConnectionStatus) => void;
  onMessageAdded?: (msg: ConversationMessage) => void;
  onMessageDelta?: (msgId: string, deltaText: string, fullText: string, latencyMs?: number) => void;
  onMessageCompleted?: (msgId: string, fullText: string, latencyMs?: number) => void;
  onUserMessageUpdated?: (msgId: string, speechDurationMs: number) => void;
  onLog?: (entry: LogEntry) => void;
  onTokenMinted?: (info: EphemeralTokenInfo) => void;
  onError?: (error: string) => void;
  onClose?: (info: CloseInfo) => void;
  onMicStateChange?: (state: MicState, detail?: string) => void;
  onMicHealth?: (health: MicHealth) => void;
  onMicLevel?: (rms: number) => void;
  onCustomerSpeaking?: (isSpeaking: boolean, itemId?: string, speechDurationMs?: number) => void;
  customInstructions?: string;
  /** Overrides for VAD endpointing; validated against the provider whitelist. */
  vadConfig?: Partial<VadConfig>;
  /** Test seam: substitutes the microphone capture implementation. */
  micCaptureFactory?: (callbacks: MicCaptureCallbacks) => MicCaptureLike;
}

/** Receives the render timestamp for a message and reports when it hit the screen. */
export interface RenderTimestampReport {
  msgId: string;
  renderedAtPerf: number;
}

/**
 * Identifies which instrumented stage of a turn consumed the most time.
 *
 * Honest caveat: the largest single contributor to perceived delay is the VAD
 * silence window *before* `input_audio_buffer.speech_stopped`, which cannot be
 * measured from inside the client — our clock starts at speech_stopped. This
 * helper ranks only the stages we actually observe.
 */
export function computeSlowestStage(t: Partial<TurnTimingDiagnostic>): string | undefined {
  const stages: Array<[string, number | undefined]> = [
    ['speech-end→committed', t.speechEndToCommittedMs],
    ['committed→transcription', t.committedToTranscriptionMs],
    ['speech-end→response-created', t.speechEndToResponseCreatedMs],
    ['response-created→first-delta', t.responseCreatedToFirstDeltaMs],
    ['first-delta→render', t.firstDeltaToFirstRenderMs],
  ];

  let slowest: string | undefined;
  let max = -1;
  for (const [label, value] of stages) {
    if (typeof value === 'number' && Number.isFinite(value) && value > max) {
      max = value;
      slowest = label;
    }
  }
  return slowest;
}


export class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private connecting = false;
  private tokenInfo: EphemeralTokenInfo | null = null;
  private options: RealtimeClientOptions;

  // Microphone capture instance
  private mic: MicCaptureLike | null = null;
  private micState: MicState = 'idle';
  private micDetail?: string;
  private micStartPromise: Promise<void> | null = null;

  /**
   * Monotonic socket generation. Every socket handler captures the epoch current
   * at creation and ignores itself once a newer socket exists. Without this, a
   * closing socket's onclose nulls the *new* socket and stops the *new* mic.
   */
  private wsEpoch = 0;

  /** Capture frames dropped because the socket was not writable. */
  private audioFramesDropped = 0;
  /** Message ids whose render time has already been recorded. */
  private renderReported = new Set<string>();

  // Active assistant turn state
  private activeAssistantMsgId: string | null = null;
  private activeAssistantText = '';

  // Active customer spoken turn state
  private pendingCustomerItemId: string | null = null;

  // Connection telemetry & counters
  private connectStartTime = 0;
  private completedTurns = 0;
  private lastInboundTimestamp = 0;
  private lastInboundType = '';
  private lastOutboundTimestamp = 0;
  private lastOutboundType = '';
  private lastAudioAppendTimestamp = 0;
  private audioAppendCount = 0;

  // Diagnostic buffers & lifecycle tracking
  private diagnosticLogs: LogEntry[] = [];
  private droppedLogCount = 0;
  private maxDiagnosticLogs = 1000;
  private bufferedAmountHistory: { timestamp: number; bytes: number }[] = [];
  private bufferSampleTimer: NodeJS.Timeout | number | null = null;

  // Event lifecycle counters
  private speechStartedCount = 0;
  private speechStoppedCount = 0;
  private speechCommittedCount = 0;
  private transcriptionCount = 0;
  private transcriptionFailureCount = 0;
  private responseCreatedCount = 0;
  private interruptedResponseCount = 0;
  private lastResponseTimestamps: {
    created?: number;
    firstDelta?: number;
    textDone?: number;
    responseDone?: number;
  } = {};
  private closeInfo: CloseInfo | null = null;
  private disconnectTime?: number;

  // Latency instrumentation timestamps & metrics
  private lastSpeechStartedPerf = 0;
  private lastSpeechStoppedPerf = 0;
  private lastSpeechCommittedPerf = 0;
  private lastTranscriptionPerf = 0;
  private lastResponseCreatedPerf = 0;
  private lastFirstDeltaPerf = 0;
  private lastFirstRenderPerf = 0;
  private lastFinalTextPerf = 0;
  /** Message id currently awaiting a render report. */
  private awaitingRenderForMsgId: string | null = null;
  /** Perf timestamp at which the first delta of this turn was received. */
  private firstDeltaReceivedAtPerf = 0;

  // Bounded Turn Timing History (last 50 turns)
  private turnHistory: TurnTimingDiagnostic[] = [];
  private currentTurnTiming: Partial<TurnTimingDiagnostic> | null = null;

  private latestLatencyMetrics: {
    speechEndToCommittedMs?: number;
    committedToTranscriptionMs?: number;
    speechEndToResponseCreatedMs?: number;
    responseCreatedToFirstDeltaMs?: number;
    firstDeltaToFirstRenderMs?: number;
    speechEndToFirstVisibleTextMs?: number;
    /** Speech end -> first delta actually painted (real render measurement). */
    speechEndToFirstRenderMs?: number;
    firstDeltaToFinalTextMs?: number;
  } = {};

  constructor(options: RealtimeClientOptions = {}) {
    this.options = options;
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getTokenInfo(): EphemeralTokenInfo | null {
    return this.tokenInfo;
  }

  public getMicState(): MicState {
    return this.micState;
  }

  public getMicHealth(): MicHealth {
    if (this.mic) {
      return { ...this.mic.getHealth(), framesDropped: this.audioFramesDropped };
    }
    return {
      state: this.micState,
      detail: this.micDetail,
      frameCount: 0,
      framesDropped: this.audioFramesDropped,
      lastFrameAt: 0,
      flowing: false,
    };
  }

  public isMicActive(): boolean {
    return this.micState === 'recording';
  }

  public isResponseStreaming(): boolean {
    return this.activeAssistantMsgId !== null;
  }

  /**
   * Called by the UI once the first streamed delta of a turn has actually been
   * painted. This is what makes "first text rendered" a measured value instead of
   * an assumption: the previous implementation hardcoded this stage to 0 ms.
   */
  public markFirstRender(msgId: string, renderedAtPerf?: number): void {
    if (!msgId || this.renderReported.has(msgId)) return;
    if (this.awaitingRenderForMsgId && this.awaitingRenderForMsgId !== msgId) return;
    if (!this.firstDeltaReceivedAtPerf) return;

    const renderedAt =
      renderedAtPerf ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());

    this.renderReported.add(msgId);
    if (this.renderReported.size > 200) {
      // Bound the memo; the ids are only needed for the current turn.
      const first = this.renderReported.values().next().value;
      if (first) this.renderReported.delete(first);
    }
    this.awaitingRenderForMsgId = null;
    this.lastFirstRenderPerf = renderedAt;

    const renderLag = Math.max(0, Math.round(renderedAt - this.firstDeltaReceivedAtPerf));
    this.latestLatencyMetrics.firstDeltaToFirstRenderMs = renderLag;
    if (this.currentTurnTiming) this.currentTurnTiming.firstDeltaToFirstRenderMs = renderLag;

    if (this.lastSpeechStoppedPerf > 0) {
      const endToRender = Math.max(0, Math.round(renderedAt - this.lastSpeechStoppedPerf));
      this.latestLatencyMetrics.speechEndToFirstRenderMs = endToRender;
      if (this.currentTurnTiming) {
        this.currentTurnTiming.speechEndToFirstRenderMs = endToRender;
        this.currentTurnTiming.slowestStage = computeSlowestStage(this.currentTurnTiming);
      }
    }
  }

  /**
   * Returns complete connection telemetry snapshot.
   */
  public getTelemetry(): ClientTelemetry {
    const now = Date.now();
    return {
      connectStartTime: this.connectStartTime,
      uptimeMs: this.connectStartTime > 0 ? (this.disconnectTime || now) - this.connectStartTime : 0,
      completedTurns: this.completedTurns,
      lastInboundTimestamp: this.lastInboundTimestamp,
      lastInboundType: this.lastInboundType,
      lastOutboundTimestamp: this.lastOutboundTimestamp,
      lastOutboundType: this.lastOutboundType,
      lastAudioAppendTimestamp: this.lastAudioAppendTimestamp,
      audioAppendCount: this.audioAppendCount,
      bufferedAmount: this.ws?.bufferedAmount ?? 0,
      isMicActive: this.isMicActive(),
      isResponseStreaming: this.isResponseStreaming(),
      timeSinceLastInboundMs: this.lastInboundTimestamp > 0 ? now - this.lastInboundTimestamp : 0,
      timeSinceLastOutboundMs: this.lastOutboundTimestamp > 0 ? now - this.lastOutboundTimestamp : 0,
    };
  }

  /**
   * Returns complete diagnostic data object for reporting.
   */
  public getExtendedDiagnosticsData(): ExtendedDiagnosticsData {
    return {
      sessionId: `boson-realtime-${this.connectStartTime}`,
      connectStartTime: this.connectStartTime,
      disconnectTime: this.disconnectTime,
      completedTurns: this.completedTurns,
      reconnectAttempts: 0,
      micState: this.micState,
      micHealth: this.getMicHealth(),
      audioFramesDropped: this.audioFramesDropped,
      isResponseStreaming: this.isResponseStreaming(),
      closeInfo: this.closeInfo,
      telemetry: this.getTelemetry(),
      logs: [...this.diagnosticLogs],
      droppedLogCount: this.droppedLogCount,
      bufferedAmountHistory: [...this.bufferedAmountHistory],
      speechStartedCount: this.speechStartedCount,
      speechStoppedCount: this.speechStoppedCount,
      speechCommittedCount: this.speechCommittedCount,
      transcriptionCount: this.transcriptionCount,
      transcriptionFailureCount: this.transcriptionFailureCount,
      responseCreatedCount: this.responseCreatedCount,
      interruptedResponseCount: this.interruptedResponseCount,
      lastResponseTimestamps: { ...this.lastResponseTimestamps },
      customInstructions: this.options.customInstructions,
      latencyMetrics: { ...this.latestLatencyMetrics },
      turnHistory: [...this.turnHistory],
    };
  }

  /**
   * Generates formatted text report for copy-to-clipboard.
   */
  public generateFullReport(): string {
    return generateFullDiagnosticReport(this.getExtendedDiagnosticsData());
  }

  public setInstructions(instructions: string) {
    this.options.customInstructions = instructions;
    if (this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.send(buildSessionConfig(instructions));
    }
  }

  /** Periodic re-emit of mic health so `flowing` degrades to false when frames stop. */
  private micHealthTimer: NodeJS.Timeout | number | null = null;

  /** Sample buffer occupancy for diagnostics. */
  private startBufferSampling(): void {
    this.stopBufferSampling();
    this.bufferSampleTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const bytes = this.ws.bufferedAmount;
        this.bufferedAmountHistory.push({ timestamp: Date.now(), bytes });
        if (this.bufferedAmountHistory.length > 50) {
          this.bufferedAmountHistory.shift();
        }
      }
    }, 2000);
  }

  private stopBufferSampling(): void {
    if (this.bufferSampleTimer !== null) {
      clearInterval(this.bufferSampleTimer as any);
      this.bufferSampleTimer = null;
    }
  }

  /**
   * Connect to Boson Higgs Realtime.
   */
  public async connect(): Promise<void> {
    if (this.connecting || this.status === 'connected' || this.status === 'connecting') {
      this.log('info', 'connect_ignored', { reason: 'Connection is already in progress or open' });
      return;
    }

    this.connecting = true;
    this.setStatus('connecting');

    let ephemeralToken: string;
    try {
      this.log('info', 'token_request', { endpoint: '/api/token' });
      const res = await fetch('/api/token');
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Server returned status ${res.status}`);
      }

      if (!data.value) {
        throw new Error('Backend response did not contain ephemeral token value');
      }

      ephemeralToken = data.value;
      this.tokenInfo = {
        value: data.value,
        expires_at: data.expires_at,
        obtained_at: Date.now(),
      };
      this.options.onTokenMinted?.(this.tokenInfo);
      this.log('info', 'token_minted', {
        expires_at: data.expires_at,
        masked: `${data.value.slice(0, 11)}...`,
      });
    } catch (err: any) {
      this.connecting = false;
      this.setStatus('error');
      const msg = err.message || 'Failed to obtain ephemeral token from backend';
      this.options.onError?.(msg);
      this.log('info', 'token_error', { error: msg });
      return;
    }

    try {
      this.log('info', 'websocket_connecting', { url: WS_BASE_URL });
      const ws = new WebSocket(WS_BASE_URL, ['realtime', `bai-client-secret.${ephemeralToken}`]);
      this.ws = ws;
      const epoch = ++this.wsEpoch;
      const isStale = () => epoch !== this.wsEpoch;

      ws.onopen = () => {
        if (isStale()) {
          // A newer socket superseded this one while it was opening.
          try {
            ws.close(1000, 'Superseded by newer connection');
          } catch {
            // ignore
          }
          return;
        }
        this.connecting = false;
        this.connectStartTime = Date.now();
        this.disconnectTime = undefined;
        this.setStatus('connected');
        this.startBufferSampling();
        this.log('info', 'websocket_open', { url: WS_BASE_URL });

        const sessionConfig = buildSessionConfig(this.options.customInstructions, this.options.vadConfig);
        this.send(sessionConfig);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (isStale()) return;
        this.handleServerMessage(event);
      };

      ws.onerror = (event: Event) => {
        if (isStale()) return;
        this.log('info', 'websocket_error', { event });
        this.options.onError?.('WebSocket connection error occurred.');
      };

      ws.onclose = (event: CloseEvent) => {
        // Never let a superseded socket tear down the live session or mic.
        if (isStale()) {
          this.log('info', 'stale_socket_close_ignored', { code: event.code });
          return;
        }

        this.connecting = false;
        this.disconnectTime = Date.now();
        this.stopBufferSampling();
        this.ws = null;
        this.activeAssistantMsgId = null;
        this.activeAssistantText = '';
        this.awaitingRenderForMsgId = null;
        this.pendingCustomerItemId = null;

        void this.stopMic();

        const telemetry = this.getTelemetry();
        const closeInfo = describeClose(event.code, event.reason);
        closeInfo.wasClean = event.wasClean;
        closeInfo.telemetry = telemetry;
        this.closeInfo = closeInfo;

        this.log('info', `websocket_close_${event.code}`, {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          telemetry,
        });

        this.setStatus('disconnected');
        this.options.onClose?.(closeInfo);
      };
    } catch (err: any) {
      this.connecting = false;
      this.setStatus('error');
      const msg = err.message || 'Failed to establish WebSocket connection';
      this.options.onError?.(msg);
      this.log('info', 'websocket_exception', { error: msg });
    }
  }

  public disconnect(): void {
    void this.stopMic();

    const ws = this.ws;
    // Invalidate this socket generation first, so any late event from it is
    // treated as stale and can never touch the next session.
    this.wsEpoch++;
    this.ws = null;
    this.connecting = false;
    this.stopBufferSampling();
    this.activeAssistantMsgId = null;
    this.activeAssistantText = '';
    this.awaitingRenderForMsgId = null;
    this.pendingCustomerItemId = null;

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      this.log('info', 'client_disconnect_requested', {});
      this.setStatus('closing');
      try {
        ws.close(1000, 'User initiated disconnect');
      } catch {
        // ignore
      }
    }

    this.setStatus('disconnected');
  }

  /** Maps a getUserMedia / AudioContext failure onto a precise user-facing state. */
  private describeMicError(err: any): { state: MicState; message: string } {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return {
        state: 'denied',
        message:
          'Microphone permission denied by the browser. Allow microphone access for this site, then press Start again.',
      };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return { state: 'unavailable', message: 'No microphone device was found. Connect a microphone and retry.' };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return {
        state: 'error',
        message: 'The microphone could not be opened — it may be in use by another application.',
      };
    }
    return {
      state: 'error',
      message: err?.message || 'Failed to initialize microphone.',
    };
  }

  private setMicState(state: MicState, detail?: string): void {
    this.micState = state;
    this.micDetail = detail;
    this.options.onMicStateChange?.(state, detail);
    this.emitMicHealth();
  }

  private emitMicHealth(): void {
    if (!this.options.onMicHealth) return;
    const base = this.mic
      ? this.mic.getHealth()
      : {
          state: this.micState,
          detail: this.micDetail,
          frameCount: 0,
          framesDropped: this.audioFramesDropped,
          lastFrameAt: 0,
          flowing: false,
        };
    this.options.onMicHealth({
      ...base,
      state: this.micState,
      detail: this.micDetail,
      framesDropped: this.audioFramesDropped,
    });
  }

  public async startMic(): Promise<void> {
    // A start is already in flight: reuse it so rapid double clicks can never
    // open two capture sessions (duplicate getUserMedia calls / double upload).
    if (this.micStartPromise) return this.micStartPromise;

    if (this.micState === 'recording') return;
    if (this.mic && this.mic.active) return;

    const run = async (): Promise<void> => {
      if (this.status !== 'connected') {
        await this.connect();
        if ((this.status as ConnectionStatus) !== 'connected') {
          throw new Error('Cannot start microphone: WebSocket is not connected.');
        }
      }

      // Discard any stale capture instance before building a new one.
      if (this.mic) {
        try {
          await this.mic.stop();
        } catch {
          // ignore
        }
        this.mic = null;
      }

      this.setMicState('requesting');
      this.log('info', 'mic_requesting_permission', {});

      const factory =
        this.options.micCaptureFactory ??
        ((callbacks: MicCaptureCallbacks) => new MicCapture(callbacks));

      const capture = factory({
        onChunk: (base64) => {
          if (this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
            this.send(inputAudioAppend(base64));
          } else {
            this.audioFramesDropped++;
          }
        },
        onLevel: (rms) => this.options.onMicLevel?.(rms),
        onStateChange: (state, detail) => {
          // Device loss, system mute and graph failures surface straight through.
          this.setMicState(state, detail);
        },
      });
      this.mic = capture;

      try {
        await capture.start();
        this.setMicState('recording');
        this.log('info', 'mic_streaming_active', { format: 'audio/pcm', rate: 24000 });
        this.startMicHealthSampling();
        this.emitMicHealth();
      } catch (err: any) {
        // MicCapture tears itself down on failure; drop our reference too.
        this.mic = null;
        const { state, message } = this.describeMicError(err);
        this.setMicState(state, message);
        this.options.onMicLevel?.(0);
        this.options.onError?.(message);
        this.log('info', 'mic_error', { error: message, state });
      }
    };

    this.micStartPromise = run().finally(() => {
      this.micStartPromise = null;
    });
    return this.micStartPromise;
  }

  public async stopMic(): Promise<void> {
    // Wait for an in-flight start so a start/stop race cannot leak a capture.
    if (this.micStartPromise) {
      try {
        await this.micStartPromise;
      } catch {
        // ignore
      }
    }

    if (!this.mic && this.micState === 'idle') return;

    const capture = this.mic;
    this.mic = null;
    this.stopMicHealthSampling();

    try {
      await capture?.stop();
    } catch (err: any) {
      this.log('info', 'mic_stop_error', { error: err?.message });
    }

    this.setMicState('idle');
    this.options.onMicLevel?.(0);
    this.log('info', 'mic_stopped', {});
  }

  private startMicHealthSampling(): void {
    this.stopMicHealthSampling();
    this.micHealthTimer = setInterval(() => this.emitMicHealth(), 1000);
  }

  private stopMicHealthSampling(): void {
    if (this.micHealthTimer !== null) {
      clearInterval(this.micHealthTimer as any);
      this.micHealthTimer = null;
    }
  }

  public sendUserText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;

    if (this.status !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('info', 'send_ignored', { reason: 'WebSocket is not currently open' });
      this.options.onError?.('Cannot send message: Not connected to Higgs Realtime.');
      return false;
    }

    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const userMsg: ConversationMessage = {
      id: userMsgId,
      role: 'user',
      text: trimmed,
      status: 'complete',
      inputMode: 'text',
      timestamp: Date.now(),
    };
    this.options.onMessageAdded?.(userMsg);

    this.send(userTextItem(trimmed));
    this.send(responseCreate());

    return true;
  }

  public send(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('info', 'send_failed', { reason: 'Socket not open', type: event.type });
      return;
    }

    const now = Date.now();
    this.lastOutboundTimestamp = now;
    this.lastOutboundType = event.type;

    if (event.type === 'input_audio_buffer.append') {
      this.audioAppendCount++;
      this.lastAudioAppendTimestamp = now;

      const b64Str = typeof event.audio === 'string' ? event.audio : '';
      const chunkLength = b64Str.length;

      const payload = JSON.stringify(event);
      this.ws.send(payload);

      if (this.audioAppendCount % 20 === 0) {
        this.log('send', 'input_audio_buffer.append', {
          appendCount: this.audioAppendCount,
          encodedChunkLength: chunkLength,
          approxBytes: Math.round((chunkLength * 3) / 4),
          bufferedAmount: this.ws.bufferedAmount,
          timestamp: now,
        });
      }
      return;
    }

    const payload = JSON.stringify(event);
    this.ws.send(payload);
    this.log('send', event.type, event, payload);
  }

  private handleServerMessage(event: MessageEvent): void {
    let serverEvent: ServerEvent;
    try {
      serverEvent = JSON.parse(event.data as string);
    } catch {
      this.log('info', 'unparseable_message', { data: String(event.data) });
      return;
    }

    const now = Date.now();
    this.lastInboundTimestamp = now;
    this.lastInboundType = serverEvent.type;

    const isHighFrequencyDelta =
      serverEvent.type === SERVER_EVENTS.outputTextDelta ||
      serverEvent.type === SERVER_EVENTS.textDelta ||
      serverEvent.type === SERVER_EVENTS.audioTranscriptDelta;

    // Streaming deltas are logged as metadata only: raw JSON per token would churn
    // the log buffer and re-render the debug drawer on every fragment.
    this.log(
      'recv',
      serverEvent.type,
      serverEvent,
      isHighFrequencyDelta ? undefined : (event.data as string)
    );

    switch (serverEvent.type) {
      case SERVER_EVENTS.sessionCreated:
      case SERVER_EVENTS.sessionUpdated: {
        this.log('info', 'session_acknowledged', {
          type: serverEvent.type,
          session: serverEvent.session,
        });
        break;
      }

      case SERVER_EVENTS.speechStarted: {
        this.speechStartedCount++;
        const itemId = (serverEvent.item_id as string) || `cust-${Date.now()}`;
        this.pendingCustomerItemId = itemId;
        this.lastSpeechStartedPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.lastSpeechStoppedPerf = 0;
        this.lastFirstDeltaPerf = 0;
        this.lastFirstRenderPerf = 0;
        this.firstDeltaReceivedAtPerf = 0;
        this.awaitingRenderForMsgId = null;
        this.currentTurnTiming = {
          turnId: itemId,
          itemId,
          timestamp: Date.now(),
          status: 'streaming',
        };
        this.options.onCustomerSpeaking?.(true, itemId);

        if (this.activeAssistantMsgId) {
          this.interruptedResponseCount++;
          this.options.onMessageCompleted?.(
            this.activeAssistantMsgId,
            this.activeAssistantText + ' [interrupted]'
          );
          this.activeAssistantMsgId = null;
          this.activeAssistantText = '';
        }

        const custMsg: ConversationMessage = {
          id: itemId,
          role: 'user',
          text: '',
          status: 'streaming',
          inputMode: 'mic',
          timestamp: Date.now(),
        };
        this.options.onMessageAdded?.(custMsg);
        break;
      }

      case SERVER_EVENTS.speechStopped: {
        this.speechStoppedCount++;
        this.lastSpeechStoppedPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const itemId = (serverEvent.item_id as string) || this.pendingCustomerItemId;
        const speechDurationMs = this.lastSpeechStartedPerf > 0
          ? Math.round(this.lastSpeechStoppedPerf - this.lastSpeechStartedPerf)
          : undefined;

        if (this.currentTurnTiming && speechDurationMs !== undefined) {
          this.currentTurnTiming.speechDurationMs = speechDurationMs;
        }

        this.options.onCustomerSpeaking?.(false, itemId || undefined, speechDurationMs);
        if (itemId && speechDurationMs !== undefined) {
          this.options.onUserMessageUpdated?.(itemId, speechDurationMs);
        }
        break;
      }

      case SERVER_EVENTS.speechCommitted: {
        this.speechCommittedCount++;
        this.lastSpeechCommittedPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.lastSpeechStoppedPerf > 0) {
          const deltaMs = Math.round(this.lastSpeechCommittedPerf - this.lastSpeechStoppedPerf);
          this.latestLatencyMetrics.speechEndToCommittedMs = deltaMs;
          if (this.currentTurnTiming) this.currentTurnTiming.speechEndToCommittedMs = deltaMs;
        }
        break;
      }

      case SERVER_EVENTS.transcriptionCompleted: {
        this.transcriptionCount++;
        this.lastTranscriptionPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.lastSpeechCommittedPerf > 0) {
          const deltaMs = Math.round(this.lastTranscriptionPerf - this.lastSpeechCommittedPerf);
          this.latestLatencyMetrics.committedToTranscriptionMs = deltaMs;
          if (this.currentTurnTiming) this.currentTurnTiming.committedToTranscriptionMs = deltaMs;
        }
        const itemId = (serverEvent.item_id as string) || this.pendingCustomerItemId;
        const transcript = (serverEvent.transcript as string) || '';
        if (this.currentTurnTiming && transcript) {
          this.currentTurnTiming.transcriptPreview = transcript.slice(0, 60);
        }
        if (itemId) {
          this.options.onMessageCompleted?.(itemId, transcript);
        }
        this.pendingCustomerItemId = null;
        break;
      }

      case SERVER_EVENTS.transcriptionFailed: {
        this.transcriptionFailureCount++;
        const itemId = (serverEvent.item_id as string) || this.pendingCustomerItemId;
        if (itemId) {
          this.options.onMessageCompleted?.(itemId, '[Spoken input: transcription unavailable]');
        }
        this.pendingCustomerItemId = null;
        break;
      }

      case SERVER_EVENTS.responseCreated: {
        this.responseCreatedCount++;
        this.lastResponseCreatedPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.lastSpeechStoppedPerf > 0) {
          const deltaMs = Math.round(this.lastResponseCreatedPerf - this.lastSpeechStoppedPerf);
          this.latestLatencyMetrics.speechEndToResponseCreatedMs = deltaMs;
          if (this.currentTurnTiming) this.currentTurnTiming.speechEndToResponseCreatedMs = deltaMs;
        }
        this.lastResponseTimestamps = { created: now };
        this.activeAssistantText = '';
        const respId = (serverEvent.response as any)?.id || `resp-${Date.now()}`;
        this.activeAssistantMsgId = respId;

        const assistantMsg: ConversationMessage = {
          id: respId,
          role: 'assistant',
          text: '',
          status: 'streaming',
          timestamp: Date.now(),
        };
        this.options.onMessageAdded?.(assistantMsg);
        break;
      }

      case SERVER_EVENTS.outputItemAdded: {
        const item = serverEvent.item as any;
        if (item?.id && item?.role === 'assistant') {
          if (!this.activeAssistantMsgId) {
            this.activeAssistantMsgId = item.id;
            this.activeAssistantText = '';
            const assistantMsg: ConversationMessage = {
              id: item.id,
              role: 'assistant',
              text: '',
              status: 'streaming',
              timestamp: Date.now(),
            };
            this.options.onMessageAdded?.(assistantMsg);
          }
        }
        break;
      }

      case SERVER_EVENTS.outputTextDelta:
      case SERVER_EVENTS.textDelta:
      case SERVER_EVENTS.audioTranscriptDelta: {
        if (!this.lastFirstDeltaPerf) {
          this.lastFirstDeltaPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
          this.firstDeltaReceivedAtPerf = this.lastFirstDeltaPerf;
          if (this.lastResponseCreatedPerf > 0) {
            const respToDelta = Math.round(this.lastFirstDeltaPerf - this.lastResponseCreatedPerf);
            this.latestLatencyMetrics.responseCreatedToFirstDeltaMs = respToDelta;
            if (this.currentTurnTiming) this.currentTurnTiming.responseCreatedToFirstDeltaMs = respToDelta;
          }
          if (this.lastSpeechStoppedPerf > 0) {
            const totalLatency = Math.round(this.lastFirstDeltaPerf - this.lastSpeechStoppedPerf);
            this.latestLatencyMetrics.speechEndToFirstVisibleTextMs = totalLatency;
            if (this.currentTurnTiming) this.currentTurnTiming.speechEndToFirstVisibleTextMs = totalLatency;
          }
          // Render latency is NOT known yet: it is reported by the UI once the
          // delta has actually been painted (see markFirstRender).
          this.lastFirstRenderPerf = 0;
          delete this.latestLatencyMetrics.firstDeltaToFirstRenderMs;
          delete this.latestLatencyMetrics.speechEndToFirstRenderMs;
          if (this.currentTurnTiming) {
            delete this.currentTurnTiming.firstDeltaToFirstRenderMs;
            delete this.currentTurnTiming.speechEndToFirstRenderMs;
          }
        }

        if (!this.lastResponseTimestamps.firstDelta) {
          this.lastResponseTimestamps.firstDelta = now;
        }

        const delta = (serverEvent.delta as string) ?? '';
        if (delta) {
          if (!this.activeAssistantMsgId) {
            const fallbackId = (serverEvent.item_id as string) || (serverEvent.response_id as string) || `resp-${Date.now()}`;
            this.activeAssistantMsgId = fallbackId;
            const assistantMsg: ConversationMessage = {
              id: fallbackId,
              role: 'assistant',
              text: '',
              status: 'streaming',
              timestamp: Date.now(),
            };
            this.options.onMessageAdded?.(assistantMsg);
          }

          this.activeAssistantText += delta;
          // The first delta of this turn is now in flight to the UI; record which
          // message must report its paint time.
          if (!this.awaitingRenderForMsgId) {
            this.awaitingRenderForMsgId = this.activeAssistantMsgId;
          }
          const currentLatency =
            this.latestLatencyMetrics.speechEndToFirstRenderMs ??
            this.latestLatencyMetrics.speechEndToFirstVisibleTextMs;
          this.options.onMessageDelta?.(
            this.activeAssistantMsgId,
            delta,
            this.activeAssistantText,
            currentLatency
          );
        }
        break;
      }

      case SERVER_EVENTS.outputTextDone:
      case SERVER_EVENTS.textDone:
      case SERVER_EVENTS.audioTranscriptDone: {
        this.lastResponseTimestamps.textDone = now;
        const text =
          (serverEvent.text as string) ||
          (serverEvent.transcript as string) ||
          this.activeAssistantText;
        if (this.activeAssistantMsgId) {
          this.activeAssistantText = text;
          const currentLatency = this.latestLatencyMetrics.speechEndToFirstVisibleTextMs;
          this.options.onMessageCompleted?.(this.activeAssistantMsgId, text, currentLatency);
        }
        break;
      }

      case SERVER_EVENTS.responseDone: {
        this.completedTurns++;
        this.lastFinalTextPerf = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (this.lastFirstDeltaPerf > 0) {
          const finalDuration = Math.round(this.lastFinalTextPerf - this.lastFirstDeltaPerf);
          this.latestLatencyMetrics.firstDeltaToFinalTextMs = finalDuration;
          if (this.currentTurnTiming) this.currentTurnTiming.firstDeltaToFinalTextMs = finalDuration;
        }
        this.lastResponseTimestamps.responseDone = now;
        const resp = serverEvent.response as any;
        const finalOutputText =
          resp?.output?.[0]?.content?.[0]?.text ||
          resp?.output?.[0]?.content?.[0]?.transcript ||
          this.activeAssistantText;

        const effectiveMsgId = this.activeAssistantMsgId || resp?.id || `resp-${Date.now()}`;
        const finalLatency = this.latestLatencyMetrics.speechEndToFirstVisibleTextMs;

        if (this.currentTurnTiming) {
          this.currentTurnTiming.status = 'complete';
          this.currentTurnTiming.slowestStage = computeSlowestStage(this.currentTurnTiming);
          this.turnHistory.push(this.currentTurnTiming as TurnTimingDiagnostic);
          if (this.turnHistory.length > 50) this.turnHistory.shift();
          this.currentTurnTiming = null;
        }

        if (!this.activeAssistantMsgId && finalOutputText) {
          const assistantMsg: ConversationMessage = {
            id: effectiveMsgId,
            role: 'assistant',
            text: finalOutputText,
            status: 'complete',
            timestamp: Date.now(),
            latencyAfterSpeechEndedMs: finalLatency,
          };
          this.options.onMessageAdded?.(assistantMsg);
        } else if (this.activeAssistantMsgId) {
          this.options.onMessageCompleted?.(
            this.activeAssistantMsgId,
            finalOutputText,
            finalLatency
          );
        }

        this.activeAssistantMsgId = null;
        this.activeAssistantText = '';
        break;
      }

      case SERVER_EVENTS.error: {
        const errObj = (serverEvent.error as any) || serverEvent;
        const msg = errObj?.message || JSON.stringify(errObj);
        this.options.onError?.(`Boson Server Error: ${msg}`);
        break;
      }

      case SERVER_EVENTS.idleTimeout: {
        this.options.onError?.('Session timed out due to inactivity.');
        break;
      }

      default:
        break;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private log(direction: 'send' | 'recv' | 'info', type: string, payload: unknown, rawJson?: string): void {
    const entry: LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      direction,
      type,
      payload,
      // Never retain unbounded raw frames (session.created carries the full
      // instruction set); the diagnostic report stays readable and memory-bounded.
      rawJson:
        rawJson === undefined
          ? undefined
          : rawJson.length > MAX_RAW_LOG_CHARS
          ? `${rawJson.slice(0, MAX_RAW_LOG_CHARS)}…[truncated ${rawJson.length - MAX_RAW_LOG_CHARS} chars]`
          : rawJson,
    };

    if (this.diagnosticLogs.length >= this.maxDiagnosticLogs) {
      this.diagnosticLogs.shift();
      this.droppedLogCount++;
    }
    this.diagnosticLogs.push(entry);

    this.options.onLog?.(entry);
  }
}
