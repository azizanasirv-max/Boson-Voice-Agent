import { addWorkletModule } from './loadWorklet';
import { createResampler, floatTo16BitPCM, type Resampler } from './resample';
import type { MicHealth, MicState } from '../realtime/types';

export const BOSON_AUDIO_RATE = 24000;

/**
 * Capture frame size. 50 ms keeps VAD granularity and upload batching balanced:
 * a 100 ms frame adds up to 100 ms of pure buffering latency before the provider
 * can see the end of speech, while 20 ms frames triple per-frame overhead
 * (base64 + JSON + WebSocket frame) with no measurable endpointing gain.
 */
export const MIC_FRAME_MS = 50;

/** Frames must start arriving quickly; if not, the audio graph is not rendering. */
export const FIRST_FRAME_TIMEOUT_MS = 1500;

/** No frame for this long means the graph is suspended or the device died. */
export const STALL_TIMEOUT_MS = 2000;
export const STALL_CHECK_INTERVAL_MS = 500;

/** A frame is "live" if one arrived within this window. */
export const FRAME_FRESHNESS_MS = 500;

/**
 * Builds the AudioWorklet source for the capture processor.
 * Frame size is derived from the live `sampleRate` inside the worklet, so this
 * generated source is the single source of truth for capture framing.
 */
export function buildCaptureWorkletSource(frameMs: number = MIC_FRAME_MS): string {
  return `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(1, Math.round(sampleRate * ${(frameMs / 1000).toFixed(6)}));
    this.buf = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.len++] = channel[i];
      if (this.len === this.frameSize) {
        // Transfer the buffer directly (no extra copy per frame); the detached
        // buffer is replaced immediately below.
        this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
        this.buf = new Float32Array(this.frameSize);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;
}

/**
 * Encodes an ArrayBuffer to base64 in chunks to prevent call-stack overflow on large frames.
 */
function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Root-mean-square level of a frame, used only for the UI meter. */
export function computeRms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    sum += frame[i] * frame[i];
  }
  return Math.sqrt(sum / frame.length);
}

export interface MicCaptureCallbacks {
  /** Called with one base64-encoded 24 kHz PCM16 chunk per capture frame. */
  onChunk: (base64: string) => void;
  /** RMS of each frame, for the level meter. */
  onLevel?: (rms: number) => void;
  /** Authoritative microphone state transitions (including device loss). */
  onStateChange?: (state: MicState, detail?: string) => void;
}

/**
 * Structural contract RealtimeClient depends on. Keeping it narrow lets tests
 * substitute a deterministic capture without touching browser audio APIs.
 */
export interface MicCaptureLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly active: boolean;
  readonly currentState: MicState;
  readonly framesReceived: number;
  isFlowing(now?: number): boolean;
  getHealth(): MicHealth;
}

// __MIC_CAPTURE_CLASS__
/**
 * Microphone Audio Capture pipeline for Boson Higgs Realtime:
 * getUserMedia -> AudioWorklet (50 ms frames) -> resample to 24 kHz -> PCM16 -> Base64
 *
 * Reliability contract:
 * - Every failure path after getUserMedia stops the tracks (never leaves a hot mic).
 * - No microphone audio is ever routed to the speakers (graph ends in a muted gain).
 * - Track loss, system mute, graph suspension and frame stalls are reported as state.
 */
export class MicCapture implements MicCaptureLike {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sinkGain: GainNode | null = null;
  private resampler: Resampler | null = null;
  private readonly callbacks: MicCaptureCallbacks;

  private frameCount = 0;
  private lastFrameAt = 0;
  private state: MicState = 'idle';
  private detail?: string;
  private deviceLabel?: string;

  private firstFrameTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private trackHandlers: Array<{ cleanup: () => void }> = [];
  private visibilityHandler: (() => void) | null = null;

  constructor(callbacks: MicCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  get active(): boolean {
    return this.node !== null;
  }

  get currentState(): MicState {
    return this.state;
  }

  get framesReceived(): number {
    return this.frameCount;
  }

  /** True only when frames arrived very recently — i.e. audio really is flowing. */
  isFlowing(now = Date.now()): boolean {
    return this.node !== null && this.lastFrameAt > 0 && now - this.lastFrameAt <= FRAME_FRESHNESS_MS;
  }

  getHealth(): MicHealth {
    return {
      state: this.state,
      detail: this.detail,
      deviceLabel: this.deviceLabel,
      frameCount: this.frameCount,
      framesDropped: 0,
      lastFrameAt: this.lastFrameAt,
      flowing: this.isFlowing(),
    };
  }

  async start(): Promise<void> {
    if (this.node) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      this.stream = stream;

      const ctx = new AudioContext();
      this.ctx = ctx;

      await addWorkletModule(ctx, buildCaptureWorkletSource());
      this.resampler = createResampler(ctx.sampleRate, BOSON_AUDIO_RATE);

      this.source = ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      this.node.port.onmessage = (e: MessageEvent) => this.handleFrame(e);
      this.node.port.onmessageerror = () => {
        this.emitState('error', 'Capture worklet message could not be deserialized.');
      };

      // The worklet graph must be pulled by the destination, but the microphone
      // must never be audible: terminate in a gain pinned to 0 (no side-tone, and
      // no acoustic path back into the device's echo canceller).
      this.sinkGain = ctx.createGain();
      this.sinkGain.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sinkGain);
      this.sinkGain.connect(ctx.destination);

      await this.ensureRunning();
      this.attachTrackListeners(stream);
      this.attachVisibilityHandler();
      this.startWatchdogs();

      this.emitState('recording');
    } catch (err) {
      // Guarantee no hot microphone and no leaked AudioContext on any failure.
      await this.teardown();
      throw err;
    }
  }

  /**
   * Guarantees the audio graph is actually rendering. A suspended AudioContext
   * produces zero frames while every other signal still looks healthy, which is
   * the worst possible failure mode for this product.
   */
  private async ensureRunning(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    // Read the state as a plain string: TypeScript narrows the AudioContextState
    // union after the early return, which would flag the post-resume check below.
    if (this.audioContextState() === 'running') return;

    try {
      await ctx.resume();
    } catch {
      // Fall through to the explicit state check below.
    }

    const finalState = this.audioContextState();
    if (finalState !== 'running') {
      const error: any = new Error(
        `Microphone audio graph is not running (AudioContext state: ${finalState}). ` +
          'The browser blocked audio start; click the microphone button again.'
      );
      error.name = 'AudioContextSuspendedError';
      throw error;
    }
  }

  private audioContextState(): string {
    return this.ctx ? String(this.ctx.state) : 'closed';
  }

  private handleFrame(e: MessageEvent): void {
    const frame = new Float32Array(e.data as ArrayBuffer);

    this.frameCount++;
    this.lastFrameAt = Date.now();
    if (this.state !== 'recording' && this.state !== 'muted') {
      this.emitState('recording');
    }

    this.callbacks.onLevel?.(computeRms(frame));

    if (!this.resampler) return;
    const resampled = this.resampler.process(frame);
    if (resampled.length === 0) return;

    const pcm16Buffer = floatTo16BitPCM(resampled);
    this.callbacks.onChunk(base64FromBuffer(pcm16Buffer));
  }
  private attachTrackListeners(stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (track.kind !== 'audio') continue;
      this.deviceLabel = track.label || undefined;

      const onEnded = () => {
        this.emitState('disconnected', 'Microphone track ended (device unplugged or permission revoked).');
      };
      const onMute = () => {
        this.emitState('muted', 'Microphone muted by the operating system or browser.');
      };
      const onUnmute = () => {
        this.emitState('recording');
      };

      track.addEventListener?.('ended', onEnded);
      track.addEventListener?.('mute', onMute);
      track.addEventListener?.('unmute', onUnmute);

      this.trackHandlers.push({
        cleanup: () => {
          track.removeEventListener?.('ended', onEnded);
          track.removeEventListener?.('mute', onMute);
          track.removeEventListener?.('unmute', onUnmute);
        },
      });
    }
  }

  private attachVisibilityHandler(): void {
    if (typeof document === 'undefined' || !document.addEventListener) return;
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      const ctx = this.ctx;
      if (ctx && ctx.state === 'suspended') {
        // Browsers suspend audio for backgrounded tabs; restore it on return.
        void ctx.resume().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', handler);
    this.visibilityHandler = handler;
  }

  private startWatchdogs(): void {
    this.clearWatchdogs();

    this.firstFrameTimer = setTimeout(() => {
      if (this.frameCount === 0 && this.node) {
        this.emitState(
          'error',
          'No audio frames received from the microphone. The audio graph is not rendering.'
        );
      }
    }, FIRST_FRAME_TIMEOUT_MS);

    this.stallTimer = setInterval(() => {
      if (!this.node || this.frameCount === 0) return;
      if (Date.now() - this.lastFrameAt > STALL_TIMEOUT_MS) {
        this.emitState('error', 'Microphone audio stalled: no frames received for over 2s.');
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private clearWatchdogs(): void {
    if (this.firstFrameTimer !== null) {
      clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = null;
    }
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private emitState(state: MicState, detail?: string): void {
    this.state = state;
    this.detail = detail;
    this.callbacks.onStateChange?.(state, detail);
  }

  async stop(): Promise<void> {
    this.callbacks.onLevel?.(0);
    const wasActive = this.node !== null;
    await this.teardown();
    this.state = 'idle';
    this.detail = undefined;
    if (wasActive) this.callbacks.onStateChange?.('idle');
  }

  /** Releases every resource exactly once. Safe to call from any failure path. */
  private async teardown(): Promise<void> {
    this.clearWatchdogs();

    for (const { cleanup } of this.trackHandlers) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    this.trackHandlers = [];

    if (this.visibilityHandler && typeof document !== 'undefined') {
      try {
        document.removeEventListener('visibilitychange', this.visibilityHandler);
      } catch {
        // ignore
      }
    }
    this.visibilityHandler = null;

    try {
      if (this.node) this.node.port.onmessage = null;
      this.node?.port.close();
      this.source?.disconnect();
      this.node?.disconnect();
      this.sinkGain?.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // Ignore track stop error
        }
      }
    }

    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // Ignore audio context close error
      }
    }

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sinkGain = null;
    this.resampler = null;
    this.frameCount = 0;
    this.lastFrameAt = 0;
    this.deviceLabel = undefined;
  }
}

