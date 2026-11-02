import { MicCapture } from '../audio/capture';
import { generateFullDiagnosticReport, type ExtendedDiagnosticsData } from './diagnostics';
import {
  SERVER_EVENTS,
  buildSessionConfig,
  describeClose,
  inputAudioAppend,
  responseCreate,
  userTextItem,
} from './events';
import type {
  ClientEvent,
  ClientTelemetry,
  CloseInfo,
  ConnectionStatus,
  ConversationMessage,
  EphemeralTokenInfo,
  LogEntry,
  MicState,
  ServerEvent,
  TurnTimingDiagnostic,
} from './types';

const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
const WS_BASE_URL = `${protocol}//${host}/ws/realtime`;

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
  onMicStateChange?: (state: MicState) => void;
  onMicLevel?: (rms: number) => void;
  onCustomerSpeaking?: (isSpeaking: boolean, itemId?: string, speechDurationMs?: number) => void;
  customInstructions?: string;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private connecting = false;
  private tokenInfo: EphemeralTokenInfo | null = null;
  private options: RealtimeClientOptions;

  // Microphone capture instance
  private mic: MicCapture | null = null;
  private micState: MicState = 'idle';

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

  public isMicActive(): boolean {
    return this.micState === 'recording';
  }

  public isResponseStreaming(): boolean {
    return this.activeAssistantMsgId !== null;
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

      ws.onopen = () => {
        this.connecting = false;
        this.connectStartTime = Date.now();
        this.disconnectTime = undefined;
        this.setStatus('connected');
        this.startBufferSampling();
        this.log('info', 'websocket_open', { url: WS_BASE_URL });

        const sessionConfig = buildSessionConfig(this.options.customInstructions);
        this.send(sessionConfig);
      };

      ws.onmessage = (event: MessageEvent) => {
        this.handleServerMessage(event);
      };

      ws.onerror = (event: Event) => {
        this.log('info', 'websocket_error', { event });
        this.options.onError?.('WebSocket connection error occurred.');
      };

      ws.onclose = (event: CloseEvent) => {
        this.connecting = false;
        this.disconnectTime = Date.now();
        this.stopBufferSampling();
        this.ws = null;
        this.activeAssistantMsgId = null;
        this.activeAssistantText = '';
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

  public async startMic(): Promise<void> {
    if (this.micState === 'recording') return;

    if (this.status !== 'connected') {
      await this.connect();
      if ((this.status as ConnectionStatus) !== 'connected') {
        throw new Error('Cannot start microphone: WebSocket is not connected.');
      }
    }

    this.micState = 'requesting';
    this.options.onMicStateChange?.('requesting');
    this.log('info', 'mic_requesting_permission', {});

    try {
      this.mic = new MicCapture(
        (base64) => {
          if (this.status === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
            this.send(inputAudioAppend(base64));
          }
        },
        (rms) => {
          this.options.onMicLevel?.(rms);
        }
      );

      await this.mic.start();
      this.micState = 'recording';
      this.options.onMicStateChange?.('recording');
      this.log('info', 'mic_streaming_active', { format: 'audio/pcm', rate: 24000 });
    } catch (err: any) {
      this.micState = 'error';
      this.options.onMicStateChange?.('error');
      this.options.onMicLevel?.(0);
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone permission denied by browser. Please allow microphone access.'
        : err.message || 'Failed to initialize microphone.';
      this.options.onError?.(msg);
      this.log('info', 'mic_error', { error: msg });
    }
  }

  public async stopMic(): Promise<void> {
    if (!this.mic && this.micState === 'idle') return;

    try {
      if (this.mic) {
        await this.mic.stop();
        this.mic = null;
      }
    } catch (err: any) {
      this.log('info', 'mic_stop_error', { error: err.message });
    }

    this.micState = 'idle';
    this.options.onMicStateChange?.('idle');
    this.options.onMicLevel?.(0);
    this.log('info', 'mic_stopped', {});
  }

  public disconnect(): void {
    void this.stopMic();

    if (this.ws && (this.status === 'connected' || this.status === 'connecting')) {
      this.setStatus('closing');
      this.log('info', 'client_disconnect_requested', {});
      this.ws.close(1000, 'User initiated disconnect');
    } else {
      this.setStatus('disconnected');
    }
    this.connecting = false;
    this.ws = null;
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

    this.log('recv', serverEvent.type, serverEvent, event.data as string);

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
          this.lastFirstRenderPerf = this.lastFirstDeltaPerf;
          this.latestLatencyMetrics.firstDeltaToFirstRenderMs = 0;
          if (this.currentTurnTiming) this.currentTurnTiming.firstDeltaToFirstRenderMs = 0;
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
          const currentLatency = this.latestLatencyMetrics.speechEndToFirstVisibleTextMs;
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
      rawJson,
    };

    if (this.diagnosticLogs.length >= this.maxDiagnosticLogs) {
      this.diagnosticLogs.shift();
      this.droppedLogCount++;
    }
    this.diagnosticLogs.push(entry);

    this.options.onLog?.(entry);
  }
}
