import { addWorkletModule } from './loadWorklet';
import { createResampler, floatTo16BitPCM, type Resampler } from './resample';

export const BOSON_AUDIO_RATE = 24000;

const captureWorkletSource = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.round(sampleRate * 0.05);
    this.buf = new Float32Array(this.frameSize);
    this.len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buf[this.len++] = channel[i];
      if (this.len === this.frameSize) {
        const frame = this.buf.slice(0, this.frameSize);
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.buf = new Float32Array(this.frameSize);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;

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

/**
 * Microphone Audio Capture pipeline for Boson Higgs Realtime:
 * getUserMedia -> AudioWorklet (100ms frames) -> resample to 24 kHz (Butterworth LPF) -> PCM16 -> Base64
 */
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private resampler: Resampler | null = null;
  private readonly onChunk: (base64: string) => void;
  private readonly onLevel?: (rms: number) => void;

  constructor(onChunk: (base64: string) => void, onLevel?: (rms: number) => void) {
    this.onChunk = onChunk;
    this.onLevel = onLevel;
  }

  get active(): boolean {
    return this.node !== null;
  }

  async start(): Promise<void> {
    if (this.node) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    const ctx = new AudioContext();
    this.ctx = ctx;

    await addWorkletModule(ctx, captureWorkletSource);
    this.resampler = createResampler(ctx.sampleRate, BOSON_AUDIO_RATE);

    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.node.port.onmessage = (e: MessageEvent) => {
      const frame = new Float32Array(e.data as ArrayBuffer);

      if (this.onLevel) {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) {
          sum += frame[i] * frame[i];
        }
        const rms = Math.sqrt(sum / frame.length);
        this.onLevel(rms);
      }

      if (!this.resampler) return;
      const resampled = this.resampler.process(frame);
      if (resampled.length === 0) return;

      const pcm16Buffer = floatTo16BitPCM(resampled);
      const b64 = base64FromBuffer(pcm16Buffer);
      this.onChunk(b64);
    };

    this.source.connect(this.node);
    this.node.connect(ctx.destination);

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  async stop(): Promise<void> {
    if (this.onLevel) {
      this.onLevel(0);
    }

    try {
      this.node?.port.close();
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // Ignore track stop error
        }
      });
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
    this.resampler = null;
  }
}
