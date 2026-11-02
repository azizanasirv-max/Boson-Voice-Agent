import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type { BackendStatusInfo, EphemeralTokenInfo } from '../realtime/types';

interface ConfigStatusProps {
  tokenInfo: EphemeralTokenInfo | null;
  backendStatus: BackendStatusInfo | null;
  onRefreshBackendStatus: () => void;
  isLoadingBackend: boolean;
}

export const ConfigStatus: React.FC<ConfigStatusProps> = ({
  tokenInfo,
  backendStatus,
  onRefreshBackendStatus,
  isLoadingBackend,
}) => {
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!tokenInfo?.expires_at) {
      setSecondsRemaining(null);
      return;
    }

    const updateTimer = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const diff = tokenInfo.expires_at - nowSec;
      setSecondsRemaining(Math.max(0, diff));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [tokenInfo]);

  const formatCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  return (
    <div className="bg-zinc-900 border-b border-zinc-800/80 px-4 py-2.5 text-xs text-zinc-300">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Backend & Key indicator */}
        <div className="flex items-center flex-wrap gap-4">
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-zinc-400">Backend:</span>
            {isLoadingBackend ? (
              <span className="text-zinc-500 flex items-center gap-1">
                <RefreshCw className="w-3 h-3 animate-spin" /> Checking...
              </span>
            ) : backendStatus?.hasApiKey ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" />
                Key Detected ({backendStatus.keyPrefix})
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-rose-400 font-medium">
                <AlertCircle className="w-3.5 h-3.5" />
                BOSON_API_KEY Missing in Environment
              </span>
            )}
          </div>

          <div className="hidden md:block w-px h-3.5 bg-zinc-700" />

          {/* Ephemeral Token Status */}
          <div className="flex items-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-zinc-400">Client Secret:</span>
            {tokenInfo ? (
              <span className="inline-flex items-center gap-1.5 font-mono text-indigo-300">
                <span className="bg-indigo-950/70 border border-indigo-800 px-1.5 py-0.5 rounded text-[11px]">
                  {tokenInfo.value.slice(0, 12)}…
                </span>
                {secondsRemaining !== null && (
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] ${
                      secondsRemaining > 60 ? 'text-zinc-400' : 'text-amber-400 font-bold'
                    }`}
                  >
                    <Clock className="w-3 h-3" />
                    {formatCountdown(secondsRemaining)}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-zinc-500 italic">Minted on Connect via /api/token</span>
            )}
          </div>
        </div>

        {/* Refresh / Docs */}
        <div className="flex items-center gap-3">
          <button
            onClick={onRefreshBackendStatus}
            disabled={isLoadingBackend}
            title="Refresh backend status"
            className="text-zinc-400 hover:text-zinc-200 transition-colors flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingBackend ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh Config</span>
          </button>
          <a
            href="https://docs.boson.ai/models/higgs-realtime/overview"
            target="_blank"
            rel="noreferrer"
            className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 transition-colors"
          >
            <span>Boson Docs</span>
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
};
