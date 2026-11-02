import React from 'react';
import {
  Activity,
  AlertCircle,
  Mic,
  MicOff,
  Radio,
  Volume2,
  VolumeX,
  Waves,
} from 'lucide-react';
import type { MicHealth, MicState } from '../realtime/types';

interface MicControlBarProps {
  micState: MicState;
  micHealth?: MicHealth | null;
  micLevel: number;
  isCustomerSpeaking: boolean;
  isConnected: boolean;
  onStartMic: () => void;
  onStopMic: () => void;
}

export const MicControlBar: React.FC<MicControlBarProps> = ({
  micState,
  micHealth,
  micLevel,
  isCustomerSpeaking,
  isConnected,
  onStartMic,
  onStopMic,
}) => {
  const isRequesting = micState === 'requesting';
  const isMuted = micState === 'muted';
  const isActive = micState === 'recording' || isMuted;
  // Trust frame flow, never intent: "recording" with no frames is NOT live audio.
  const isFlowing = Boolean(micHealth?.flowing) && micState === 'recording';
  const isStalled = micState === 'recording' && Boolean(micHealth) && !micHealth?.flowing;

  // Scale RMS to percentage (0 - 100) with a curve for sensitivity
  const normalizedLevel = Math.min(100, Math.round(Math.sqrt(micLevel) * 200));

  const statusChip = (() => {
    if (micState === 'denied') {
      return {
        className: 'text-rose-300 bg-rose-950/80 border-rose-800/80',
        icon: <AlertCircle className="w-3 h-3" />,
        label: 'Permission denied',
      };
    }
    if (micState === 'unavailable') {
      return {
        className: 'text-rose-300 bg-rose-950/80 border-rose-800/80',
        icon: <AlertCircle className="w-3 h-3" />,
        label: 'No microphone found',
      };
    }
    if (micState === 'disconnected') {
      return {
        className: 'text-rose-300 bg-rose-950/80 border-rose-800/80',
        icon: <MicOff className="w-3 h-3" />,
        label: 'Microphone disconnected',
      };
    }
    if (micState === 'error') {
      return {
        className: 'text-rose-300 bg-rose-950/80 border-rose-800/80',
        icon: <AlertCircle className="w-3 h-3" />,
        label: 'Microphone error',
      };
    }
    if (isMuted) {
      return {
        className: 'text-amber-300 bg-amber-950/80 border-amber-800/80',
        icon: <MicOff className="w-3 h-3" />,
        label: 'Microphone muted by system',
      };
    }
    if (isStalled) {
      return {
        className: 'text-amber-300 bg-amber-950/80 border-amber-800/80',
        icon: <AlertCircle className="w-3 h-3" />,
        label: 'Open, but no audio flowing',
      };
    }
    if (isFlowing) {
      return {
        className: 'text-emerald-400 bg-emerald-950/80 border-emerald-800/80',
        icon: <Radio className="w-3 h-3 animate-ping text-emerald-400" />,
        label: 'Streaming Live (24kHz PCM16)',
      };
    }
    return {
      className: 'text-zinc-400 bg-zinc-800 border-zinc-700',
      icon: null,
      label: isRequesting ? 'Requesting permission…' : 'Microphone Inactive',
    };
  })();

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 shadow-xs">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
        {/* Left: Customer Mic Toggle & Status */}
        <div className="flex items-center gap-3">
          {isActive ? (
            <button
              onClick={onStopMic}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-all shadow-md shadow-rose-600/20 cursor-pointer"
            >
              <MicOff className="w-4 h-4" />
              <span>Stop Microphone</span>
            </button>
          ) : (
            <button
              onClick={onStartMic}
              disabled={isRequesting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs transition-all shadow-md shadow-emerald-600/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <Mic className="w-4 h-4" />
              <span>{isRequesting ? 'Requesting Mic...' : 'Start Customer Mic'}</span>
            </button>
          )}

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-zinc-200">
                Customer Audio Channel
              </span>
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded border ${statusChip.className}`}
              >
                {statusChip.icon}
                {statusChip.label}
              </span>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-zinc-400 mt-0.5">
              {micHealth?.detail ? (
                <span className="text-amber-300 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {micHealth.detail}
                </span>
              ) : isCustomerSpeaking ? (
                <span className="text-emerald-300 font-semibold flex items-center gap-1 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Customer speaking — Server VAD turn active
                </span>
              ) : isFlowing ? (
                <span className="text-cyan-400 flex items-center gap-1">
                  <Activity className="w-3 h-3 text-cyan-400" />
                  Server VAD listening for customer speech...
                </span>
              ) : (
                <span className="text-zinc-500">
                  {isConnected
                    ? 'Click "Start Customer Mic" to stream spoken audio to Higgs Realtime'
                    : 'Connect to the backend to stream customer audio'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Live Audio Level Visualizer & Modality Reminder */}
        <div className="flex items-center gap-4">
          {/* Level Meter Bar */}
          <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 min-w-[180px]">
            {isFlowing && normalizedLevel > 5 ? (
              <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
            <div className="flex-1 flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                <span>Mic Level</span>
                <span>{isFlowing ? `${normalizedLevel}%` : '0%'}</span>
              </div>
              <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-75 rounded-full ${
                    isCustomerSpeaking
                      ? 'bg-emerald-400'
                      : normalizedLevel > 50
                      ? 'bg-amber-400'
                      : 'bg-indigo-500'
                  }`}
                  style={{ width: `${isFlowing ? normalizedLevel : 0}%` }}
                />
              </div>
              {micHealth ? (
                <div className="text-[9px] font-mono text-zinc-500">
                  frames {micHealth.frameCount} · dropped {micHealth.framesDropped}
                  {micHealth.deviceLabel ? ` · ${micHealth.deviceLabel}` : ''}
                </div>
              ) : null}
            </div>
          </div>

          {/* Text-Only Output Reminder Badge */}
          <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-zinc-400 bg-zinc-950 px-2.5 py-1.5 rounded-lg border border-zinc-800">
            <span className="w-2 h-2 rounded-full bg-cyan-400" />
            <span>Higgs Modality: <strong className="text-zinc-200">Text Only</strong> (Zero Assistant Audio)</span>
          </div>
        </div>
      </div>
    </div>
  );
};
