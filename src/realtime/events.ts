import type { ClientEvent, CloseInfo, ServerEvent } from './types';

/**
 * Standard server event types from Boson AI Higgs Realtime API.
 * Verified against Boson Realtime API and Higgs-Realtime-Tutorial references.
 */
export const SERVER_EVENTS = {
  /** Acknowledges the initial session.update with full resolved session */
  sessionCreated: 'session.created',
  /** Acknowledges subsequent session.update messages */
  sessionUpdated: 'session.updated',
  /** A new assistant response turn has started */
  responseCreated: 'response.created',
  /** An output item was added to the response */
  outputItemAdded: 'response.output_item.added',
  /** A content part was added to an item */
  contentPartAdded: 'response.content_part.added',
  /** Streaming incremental text delta for text output modality */
  outputTextDelta: 'response.output_text.delta',
  textDelta: 'response.text.delta',
  /** Text stream completed for an item */
  outputTextDone: 'response.output_text.done',
  textDone: 'response.text.done',
  /** Audio transcript delta (available if model provides transcript stream) */
  audioTranscriptDelta: 'response.output_audio_transcript.delta',
  audioTranscriptDone: 'response.output_audio_transcript.done',
  /** Output item completed */
  outputItemDone: 'response.output_item.done',
  /** Turn response is fully completed */
  responseDone: 'response.done',
  /** Voice Activity Detection: user speech began */
  speechStarted: 'input_audio_buffer.speech_started',
  /** Voice Activity Detection: user speech ended */
  speechStopped: 'input_audio_buffer.speech_stopped',
  /** Audio buffer committed for model turn */
  speechCommitted: 'input_audio_buffer.committed',
  /** Spoken customer transcription delivered */
  transcriptionCompleted: 'conversation.item.input_audio_transcription.completed',
  /** Spoken customer transcription failed */
  transcriptionFailed: 'conversation.item.input_audio_transcription.failed',
  /** Error occurred */
  error: 'error',
  /** Session closed due to idle timeout (typically 5 min inactivity) */
  idleTimeout: 'session.idle_timeout',
  /** Session hit wall-clock cap */
  maxDuration: 'session.max_duration_reached',
} as const;

/**
 * Maps WebSocket numeric close codes to clear, human-legible messages.
 */
export function describeClose(code: number, reason: string): CloseInfo {
  switch (code) {
    case 1000:
      return {
        code,
        reason,
        message: reason ? `Session closed normally: ${reason}` : 'Session closed normally.',
        retryable: true,
      };
    case 1001:
      return {
        code,
        reason,
        message: 'Endpoint going away (browser navigation or server shutdown).',
        retryable: true,
      };
    case 1013:
      return {
        code,
        reason,
        message: 'Server at maximum concurrency capacity (1013). Please retry shortly.',
        retryable: true,
      };
    case 3000:
      return {
        code,
        reason,
        message: 'Authentication failed (3000): invalid or expired ephemeral key.',
        retryable: false,
      };
    case 4429:
      return {
        code,
        reason,
        message: 'Billing quota or entitlement refused (4429). Check Boson AI account balance.',
        retryable: false,
      };
    default:
      return {
        code,
        reason,
        message: `Socket closed with code ${code}${reason ? `: ${reason}` : ''}.`,
        retryable: code === 1006, // 1006 is abnormal closure / connection drop
      };
  }
}

export const DEFAULT_SALES_COPILOT_INSTRUCTIONS = `
You are "Jordan", an AI sales copilot for LocalSignal Agency, sitting silently alongside a human salesperson who is on a live sales discovery call with an agency prospect.

BACKGROUND & APPROVED OFFER FACTS:
- Agency: LocalSignal Agency
- Position & Role: Jordan, AI Sales Assistant for LocalSignal Agency.
- Service: White-label Google Business Profile (GBP) content and maintenance support for local SEO and digital marketing agencies.
- Standard Approved Offer: $250 per month, covering 2 client locations. Includes asynchronous written briefs and reporting delivered under the client agency's own brand.

OPERATIONAL RULES FOR YOUR OUTPUT:
1. You are advising the HUMAN SALESPERSON, NOT talking directly to the customer. Never address the customer as if you are speaking directly on the phone call.
2. Provide word-for-word ready-to-speak responses that the salesperson can read aloud immediately. The first sentence MUST be immediately usable, concise, natural, and directly relevant to the customer's last statement.
3. Structure your response in plain text with:
   "Ready-to-speak phrase for salesperson"

   [Coaching Note: Optional brief 1-sentence guidance]
4. STRICT FACTUALITY & BOUNDARIES:
   - NEVER guarantee Google ranking improvements, traffic, reviews, or sales outcomes.
   - NEVER invent features, discounts, refund policies, setup fees, case studies, or client counts.
   - If asked about an unconfirmed detail or custom pricing for more locations (e.g. 20 locations), state that the package covers 2 locations for $250/mo, acknowledge the request, and suggest confirming custom details with the LocalSignal agency team.
5. OBJECTION HANDLING & RESPECT:
   - Price objection: Frame value around 2 locations for $250/mo without making false ROI claims.
   - Competitor/existing workflow: Ask concise discovery questions about current bottlenecks.
   - "Not interested" or request to stop: Respect the prospect's answer gracefully; do not pressure or pursue.
`.trim();

/**
 * Voice Activity Detection configuration.
 *
 * IMPORTANT: the provider schema (`components.schemas.TurnDetection` in
 * docs.boson.ai/asyncapi.json) declares `additionalProperties: false` and allows
 * ONLY `type`, `threshold`, `prefix_padding_ms`, `silence_duration_ms` and
 * `min_speech_duration`. OpenAI-style keys such as `create_response` or
 * `interrupt_response` are NOT part of this protocol: sending them makes the
 * `session.update` fail and the session be closed, so they are rejected here.
 *
 * Provider defaults: threshold 0.85, prefix_padding_ms 300,
 * silence_duration_ms 500, min_speech_duration 0.125.
 */
export interface VadConfig {
  type: 'server_vad';
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  min_speech_duration: number;
}

/**
 * Tuned endpointing values actually used in production today. `threshold: 0.5`
 * is more sensitive than the 0.85 provider default (quiet prospect audio on a
 * laptop mic still trips VAD), and 350 ms is more aggressive than the 500 ms
 * provider default to cut end-of-turn dead air. Both are retained deliberately:
 * `test/vad-ab.ts` exists to compare 650/550/500 ms fairly on a real session
 * before any of these numbers is changed.
 */
export const DEFAULT_VAD_CONFIG: VadConfig = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 350,
  min_speech_duration: 0.125,
};

/** Every field the provider accepts inside `audio.input.turn_detection`. */
export const VAD_ALLOWED_FIELDS = [
  'type',
  'threshold',
  'prefix_padding_ms',
  'silence_duration_ms',
  'min_speech_duration',
] as const;

/** Field names that look plausible but are not in the protocol. */
const VAD_FORBIDDEN_FIELDS = ['create_response', 'interrupt_response', 'idle_timeout_ms'];

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`VAD field "${name}" must be a finite number, received: ${String(value)}`);
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * Builds a validated, whitelisted `turn_detection` object.
 * Throws on unknown/forbidden keys instead of silently degrading the session.
 */
export function buildTurnDetection(overrides: Partial<VadConfig> = {}): Record<string, unknown> {
  for (const key of Object.keys(overrides)) {
    if (VAD_FORBIDDEN_FIELDS.includes(key)) {
      throw new Error(
        `turn_detection.${key} is not part of the Boson Higgs Realtime protocol ` +
          '(TurnDetection declares additionalProperties: false); it would close the session.'
      );
    }
    if (!(VAD_ALLOWED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Unknown turn_detection field: ${key}`);
    }
  }

  // Emit only whitelisted keys, in the provider's documented order.
  return {
    type: 'server_vad' as const,
    threshold: clampNumber(overrides.threshold, 0, 1, DEFAULT_VAD_CONFIG.threshold, 'threshold'),
    prefix_padding_ms: clampNumber(
      overrides.prefix_padding_ms,
      0,
      5000,
      DEFAULT_VAD_CONFIG.prefix_padding_ms,
      'prefix_padding_ms'
    ),
    silence_duration_ms: clampNumber(
      overrides.silence_duration_ms,
      0,
      5000,
      DEFAULT_VAD_CONFIG.silence_duration_ms,
      'silence_duration_ms'
    ),
    min_speech_duration: clampNumber(
      overrides.min_speech_duration,
      0,
      10,
      DEFAULT_VAD_CONFIG.min_speech_duration,
      'min_speech_duration'
    ),
  };
}

/**
 * Builds the initial session.update event.
 * CRITICAL MODALITY REQUIREMENT:
 * Enforces output_modalities: ["text"]. Zero assistant audio is generated.
 * Configures server_vad and speech transcription for customer microphone streaming.
 * With server VAD the provider creates the response itself after
 * `input_audio_buffer.speech_stopped`, so no per-turn response.create is sent.
 */
export function buildSessionConfig(
  instructions?: string,
  vadOverrides: Partial<VadConfig> = {}
): ClientEvent {
  return {
    type: 'session.update',
    session: {
      model: 'higgs-realtime',
      instructions: instructions || DEFAULT_SALES_COPILOT_INSTRUCTIONS,
      // Explicitly text-only output as required by specification
      output_modalities: ['text'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: buildTurnDetection(vadOverrides),
          transcription: { model: 'higgs-stt-3.1', language: 'en' },
        },
      },
    },
  };
}


/**
 * Creates a user text conversation item event.
 */
export function userTextItem(text: string): ClientEvent {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text,
        },
      ],
    },
  };
}

/**
 * Triggers response generation for the current conversation state.
 * Must be sent following conversation.item.create for typed turns.
 * Never needed for microphone turns: server VAD creates the response itself
 * ("Server VAD detected the end of user speech; a response follows automatically").
 */
export function responseCreate(): ClientEvent {
  return {
    type: 'response.create',
  };
}

/**
 * Cancels the in-flight response. The cancelled response finishes with
 * `response.done` (status: "cancelled").
 */
export function responseCancel(): ClientEvent {
  return {
    type: 'response.cancel',
  };
}

/**
 * Streams one 50 ms chunk of customer microphone audio: base64-encoded 24 kHz PCM16.
 * The provider accepts up to 1,048,576 base64 bytes (~15 s of 24 kHz PCM16) per append.
 */
export function inputAudioAppend(base64: string): ClientEvent {
  return {
    type: 'input_audio_buffer.append',
    audio: base64,
  };
}

