import React from 'react';
import {
  Activity,
  Check,
  CheckCircle2,
  Cpu,
  FileCode2,
  FileText,
  Plug,
  PowerOff,
  RefreshCw,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { ConnectionStatus } from '../realtime/types';

interface HeaderProps {
  status: ConnectionStatus;
  onConnect: () => void;
  onDisconnect: () => void;
  onClearConversation: () => void;
  onOpenDiagnostics: () => void;
  onToggleDebugDrawer: () => void;
  isDebugDrawerOpen: boolean;
  eventCount: number;
  onCopyFullDiagnostics: () => void;
  isDiagnosticsCopied?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  status,
  onConnect,
  onDisconnect,
  onClearConversation,
  onOpenDiagnostics,
  onToggleDebugDrawer,
  isDebugDrawerOpen,
  eventCount,
  onCopyFullDiagnostics,
  isDiagnosticsCopied,
}) => {
  const getStatusBadge = () => {
    switch (status) {
      case 'connected':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 shadow-xs">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Connected
          </span>
        );
      case 'connecting':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-950/80 text-amber-400 border border-amber-800/80">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Connecting
          </span>
        );
      case 'closing':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-950/80 text-amber-400 border border-amber-800/80">
            Closing...
          </span>
        );
      case 'error':
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-rose-950/80 text-rose-400 border border-rose-800/80">
            Error
          </span>
        );
      case 'disconnected':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
            <span className="w-2 h-2 rounded-full bg-zinc-500" />
            Disconnected
          </span>
        );
    }
  };

  return (
    <header className="border-b border-zinc-800 bg-zinc-900/90 backdrop-blur-md sticky top-0 z-20 px-4 py-3">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
        {/* Brand & Stage info */}
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-indigo-500 to-violet-600 rounded-lg shadow-md shadow-indigo-500/20 text-white">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold text-zinc-100 tracking-tight">
                Boson AI Sales Copilot
              </h1>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-950 text-emerald-300 border border-emerald-800/60">
                Stage 3: Sales Copilot &amp; Diagnostics
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono mt-0.5">
              <span>LocalSignal Agency</span>
              <span>•</span>
              <span className="text-emerald-400">server_vad</span>
              <span>•</span>
              <span className="text-cyan-400 font-semibold">output_modalities: ["text"]</span>
            </div>
          </div>
        </div>

        {/* Center / Right controls */}
        <div className="flex items-center flex-wrap gap-2.5">
          {getStatusBadge()}

          {/* Connect / Disconnect */}
          {status === 'connected' ? (
            <button
              onClick={onDisconnect}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-rose-600/20 text-rose-300 hover:bg-rose-600/30 border border-rose-500/30 transition-colors cursor-pointer"
            >
              <PowerOff className="w-3.5 h-3.5" />
              Disconnect
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={status === 'connecting'}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Plug className="w-3.5 h-3.5" />
              Connect
            </button>
          )}

          {/* Prominent One-Click Full Diagnostics Button */}
          <button
            onClick={onCopyFullDiagnostics}
            title="Copy structured diagnostic report (redacted, no secrets/Base64)"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
          >
            {isDiagnosticsCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>Copied Full Report!</span>
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5" />
                <span>Copy Full Diagnostics</span>
              </>
            )}
          </button>

          {/* Clear Conversation */}
          <button
            onClick={onClearConversation}
            title="Clear conversation messages"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white border border-zinc-700 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-zinc-400" />
            <span className="hidden sm:inline">Clear Chat</span>
          </button>

          {/* Test Diagnostics */}
          <button
            onClick={onOpenDiagnostics}
            title="Run verification tests"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-indigo-300 hover:bg-zinc-700 border border-indigo-900/60 transition-colors cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400" />
            <span>Test Suite</span>
          </button>

          {/* Debug Drawer Toggle */}
          <button
            onClick={onToggleDebugDrawer}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer ${
              isDebugDrawerOpen
                ? 'bg-indigo-600 text-white border-indigo-500'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border-zinc-700'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Events ({eventCount})</span>
          </button>
        </div>
      </div>
    </header>
  );
};
