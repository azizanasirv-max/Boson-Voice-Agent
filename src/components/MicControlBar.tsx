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
import type { MicState } from '../realtime/types';

interface MicControlBarProps {
  micState: MicState;
  micLevel: number;
  isCustomerSpeaking: boolean;
  isConnected: boolean;
  onStartMic: () => void;
  onStopMic: () => void;
}

export const MicControlBar: React.FC<MicControlBarProps> = ({
  micState,
  micLevel,
  isCustomerSpeaking,
  isConnected,
  onStartMic,
  onStopMic,
}) => {
  const isRecording = micState === 'recording';
  const isRequesting = micState === 'requesting';

  // Scale RMS to percentage (0 - 100) with a curve for sensitivity
  const normalizedLevel = Math.min(100, Math.round(Math.sqrt(micLevel) * 200));

  return (
    <div className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 shadow-xs">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
        {/* Left: Customer Mic Toggle & Status */}
        <div className="flex items-center gap-3">
          {isRecording ? (
            <button
              onClick={onStopMic}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-all shadow-md shadow-rose-600/20 cursor-pointer animate-pulse"
            >
              <MicOff className="w-4 h-4" />
              <span>Stop Microphone</span>
            </button>
          ) : (
            <button
              onClick={onStartMic}
              disabled={isRequesting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs transition-all shadow-md shadow-emerald-600/20 disabled:opacity-50 cursor-pointer"
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
              {isRecording ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800/80">
                  <Radio className="w-3 h-3 animate-ping text-emerald-400" />
                  Streaming Live (24kHz PCM16)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded border border-zinc-700">
                  Microphone Inactive
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-[11px] text-zinc-400 mt-0.5">
              {isCustomerSpeaking ? (
                <span className="text-emerald-300 font-semibold flex items-center gap-1 animate-pulse">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  Customer speaking — Server VAD turn active
                </span>
              ) : isRecording ? (
                <span className="text-cyan-400 flex items-center gap-1">
                  <Activity className="w-3 h-3 text-cyan-400" />
                  Server VAD listening for customer speech...
                </span>
              ) : (
                <span className="text-zinc-500">
                  Click "Start Customer Mic" to stream spoken audio to Higgs Realtime
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right: Live Audio Level Visualizer & Modality Reminder */}
        <div className="flex items-center gap-4">
          {/* Level Meter Bar */}
          <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 min-w-[180px]">
            {isRecording && normalizedLevel > 5 ? (
              <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            )}
            <div className="flex-1 flex flex-col gap-0.5">
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                <span>Mic Level</span>
                <span>{isRecording ? `${normalizedLevel}%` : '0%'}</span>
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
                  style={{ width: `${isRecording ? normalizedLevel : 0}%` }}
                />
              </div>
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
