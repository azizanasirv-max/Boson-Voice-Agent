import React, { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Info,
  Search,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { LogEntry } from '../realtime/types';

interface EventLogDrawerProps {
  logs: LogEntry[];
  isOpen: boolean;
  onClose: () => void;
  onClearLogs: () => void;
  onCopyFullDiagnostics: () => void;
  isDiagnosticsCopied?: boolean;
}

export const EventLogDrawer: React.FC<EventLogDrawerProps> = ({
  logs,
  isOpen,
  onClose,
  onClearLogs,
  onCopyFullDiagnostics,
  isDiagnosticsCopied,
}) => {
  const [filter, setFilter] = useState<'all' | 'recv' | 'send' | 'info'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  if (!isOpen) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyLogPayload = (id: string, payload: unknown) => {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const exportLogsAsJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute(
      'download',
      `higgs-realtime-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const filteredLogs = logs.filter((log) => {
    if (filter !== 'all' && log.direction !== filter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const typeMatch = log.type.toLowerCase().includes(q);
    const contentMatch = JSON.stringify(log.payload).toLowerCase().includes(q);
    return typeMatch || contentMatch;
  });

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] lg:w-[560px] bg-zinc-950/95 border-l border-zinc-800 shadow-2xl z-30 flex flex-col backdrop-blur-md">
      {/* Drawer Header */}
      <div className="p-3.5 border-b border-zinc-800 flex items-center justify-between gap-2 bg-zinc-900/60">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-zinc-100">Debug Event Log</h3>
          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700">
            {logs.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Prominent One-Click Full Diagnostics Button */}
          <button
            onClick={onCopyFullDiagnostics}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
          >
            {isDiagnosticsCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>Copied Report!</span>
              </>
            ) : (
              <>
                <FileText className="w-3.5 h-3.5" />
                <span>Copy Full Diagnostics</span>
              </>
            )}
          </button>

          <button
            onClick={exportLogsAsJson}
            title="Download event stream JSON"
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={onClearLogs}
            title="Clear all logs"
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="p-3 border-b border-zinc-800/80 bg-zinc-900/30 space-y-2">
        <div className="flex items-center gap-1.5 text-xs">
          {(['all', 'recv', 'send', 'info'] as const).map((dir) => (
            <button
              key={dir}
              onClick={() => setFilter(dir)}
              className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition-colors cursor-pointer ${
                filter === dir
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              {dir === 'recv' ? 'Received (Server)' : dir === 'send' ? 'Sent (Client)' : dir}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by event type or keyword..."
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Event Stream List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-xs">
        {filteredLogs.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 font-sans text-xs">
            No events match the current filter.
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isExpanded = expandedIds[log.id];
            const isRecv = log.direction === 'recv';
            const isSend = log.direction === 'send';
            const isError = log.type.includes('error') || log.type.includes('fail');

            return (
              <div
                key={log.id}
                className={`p-2.5 rounded-lg border transition-all ${
                  isError
                    ? 'bg-rose-950/40 border-rose-800/60 text-rose-200'
                    : isRecv
                    ? 'bg-zinc-900/90 border-zinc-800 text-zinc-200'
                    : isSend
                    ? 'bg-indigo-950/30 border-indigo-900/50 text-indigo-200'
                    : 'bg-zinc-900/50 border-zinc-800/80 text-zinc-400'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <button
                      onClick={() => toggleExpand(log.id)}
                      className="p-0.5 hover:text-white text-zinc-400 cursor-pointer shrink-0"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>

                    <span
                      className={`inline-flex items-center gap-1 font-bold shrink-0 ${
                        isRecv
                          ? 'text-cyan-400'
                          : isSend
                          ? 'text-indigo-400'
                          : 'text-amber-400'
                      }`}
                    >
                      {isRecv ? (
                        <ArrowDownLeft className="w-3 h-3" />
                      ) : isSend ? (
                        <ArrowUpRight className="w-3 h-3" />
                      ) : (
                        <Info className="w-3 h-3" />
                      )}
                      {log.direction.toUpperCase()}
                    </span>

                    <span className="font-semibold text-zinc-100 truncate">
                      {log.type}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-zinc-500">
                      {new Date(log.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                    <button
                      onClick={() => copyLogPayload(log.id, log.payload)}
                      className="p-1 hover:text-white transition-colors cursor-pointer text-zinc-400"
                      title="Copy payload"
                    >
                      {copiedId === log.id ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="mt-2 pt-2 border-t border-zinc-800/80 overflow-x-auto">
                    <pre className="text-[11px] leading-relaxed text-zinc-300 font-mono whitespace-pre-wrap break-all bg-zinc-950 p-2 rounded border border-zinc-800">
                      {JSON.stringify(log.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
