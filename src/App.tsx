import React, { useEffect, useRef, useState } from 'react';
import { ConfigStatus } from './components/ConfigStatus';
import { ConversationView } from './components/ConversationView';
import { EventLogDrawer } from './components/EventLogDrawer';
import { FallbackDiagnosticsModal } from './components/FallbackDiagnosticsModal';
import { Header } from './components/Header';
import { InputBar } from './components/InputBar';
import { MicControlBar } from './components/MicControlBar';
import { TestDiagnosticsModal } from './components/TestDiagnosticsModal';
import { RealtimeClient } from './realtime/RealtimeClient';
import type {
  BackendStatusInfo,
  CloseInfo,
  ConnectionStatus,
  ConversationMessage,
  EphemeralTokenInfo,
  LogEntry,
  MicHealth,
  MicState,
} from './realtime/types';

/** Mic level drives a 60fps-ish meter; 10 Hz is visually identical and 6x cheaper. */
const MIC_LEVEL_EMIT_INTERVAL_MS = 100;

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tokenInfo, setTokenInfo] = useState<EphemeralTokenInfo | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatusInfo | null>(null);
  const [isLoadingBackend, setIsLoadingBackend] = useState(false);
  const [isDebugDrawerOpen, setIsDebugDrawerOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Diagnostics Export & Fallback State
  const [isDiagnosticsCopied, setIsDiagnosticsCopied] = useState(false);
  const [isFallbackModalOpen, setIsFallbackModalOpen] = useState(false);
  const [fallbackReportText, setFallbackReportText] = useState('');

  // Stage 2: Microphone and VAD state
  const [micState, setMicState] = useState<MicState>('idle');
  const [micHealth, setMicHealth] = useState<MicHealth | null>(null);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [isCustomerSpeaking, setIsCustomerSpeaking] = useState<boolean>(false);

  const clientRef = useRef<RealtimeClient | null>(null);
  const lastMicLevelEmitRef = useRef<number>(0);
  /** Assistant message ids whose first paint has already been reported. */
  const reportedRenderRef = useRef<Set<string>>(new Set());

  // Fetch backend status
  const fetchBackendStatus = async () => {
    setIsLoadingBackend(true);
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setBackendStatus(data);
        if (!data.hasApiKey) {
          setBannerError(
            'BOSON_API_KEY is not configured in the server environment (.env or environment variables). Please add your Boson API key to mint ephemeral tokens.'
          );
        } else {
          setBannerError(null);
        }
      }
    } catch {
      setBannerError('Unable to reach backend /api/status endpoint. Is the server running?');
    } finally {
      setIsLoadingBackend(false);
    }
  };

  useEffect(() => {
    fetchBackendStatus();

    // Initialize RealtimeClient with Stage 2/3 microphone, VAD, and telemetry callbacks
    const client = new RealtimeClient({
      onStatusChange: (newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'connected') {
          setBannerError(null);
        }
      },
      onMessageAdded: (msg) => {
        setMessages((prev) => [...prev, msg]);
      },
      onMessageDelta: (msgId, _deltaText, fullText, latencyMs) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  text: fullText,
                  ...(latencyMs !== undefined ? { latencyAfterSpeechEndedMs: latencyMs } : {}),
                }
              : m
          )
        );
      },
      onMessageCompleted: (msgId, fullText, latencyMs) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  text: fullText,
                  status: 'complete',
                  ...(latencyMs !== undefined ? { latencyAfterSpeechEndedMs: latencyMs } : {}),
                }
              : m
          )
        );
      },
      onUserMessageUpdated: (msgId, speechDurationMs) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? { ...m, speechDurationMs, speechEndedTimestamp: Date.now() }
              : m
          )
        );
      },
      onLog: (entry) => {
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      },
      onTokenMinted: (token) => {
        setTokenInfo(token);
      },
      onMicStateChange: (newMicState, detail) => {
        setMicState(newMicState);
        if (detail && (newMicState === 'error' || newMicState === 'denied' || newMicState === 'unavailable' || newMicState === 'disconnected')) {
          setBannerError(detail);
        }
      },
      onMicHealth: (health) => {
        setMicHealth(health);
      },
      onMicLevel: (rms) => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        // Always flush a zero level so the meter drops immediately when the mic closes.
        if (rms === 0 || now - lastMicLevelEmitRef.current >= MIC_LEVEL_EMIT_INTERVAL_MS) {
          lastMicLevelEmitRef.current = now;
          setMicLevel((prev) => (prev === rms ? prev : rms));
        }
      },
      onCustomerSpeaking: (speaking, itemId, speechDurationMs) => {
        setIsCustomerSpeaking(speaking);
        if (!speaking && itemId && speechDurationMs !== undefined) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === itemId
                ? { ...m, speechDurationMs, speechEndedTimestamp: Date.now() }
                : m
            )
          );
        }
      },
      onError: (errMsg) => {
        setBannerError(errMsg);
      },
      onClose: (closeInfo: CloseInfo) => {
        if (!closeInfo.retryable && closeInfo.code !== 1000) {
          const telemetryStr = closeInfo.telemetry
            ? ` (Uptime: ${(closeInfo.telemetry.uptimeMs / 1000).toFixed(1)}s, Turns: ${closeInfo.telemetry.completedTurns}, Last Inbound: ${closeInfo.telemetry.lastInboundType} ${closeInfo.telemetry.timeSinceLastInboundMs}ms ago)`
            : '';
          setBannerError(`${closeInfo.message}${telemetryStr}`);
        }
      },
    });

    clientRef.current = client;

    return () => {
      client.disconnect();
    };
  }, []);

  /**
   * Reports the real paint time of the first streamed assistant text.
   * Two chained rAFs guarantee the frame containing the delta has been painted
   * before we timestamp it, so "first text rendered" is measured, not assumed.
   */
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;

    const pending = messages.find(
      (m) => m.role === 'assistant' && m.text.length > 0 && !reportedRenderRef.current.has(m.id)
    );
    if (!pending) return;

    const msgId = pending.id;
    // No cleanup that cancels the frame: `messages` changes on every streamed
    // delta, and cancelling here would repeatedly abort the very paint we want to
    // timestamp. Duplicate scheduling is harmless (markFirstRender is idempotent).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reportedRenderRef.current.add(msgId);
        if (reportedRenderRef.current.size > 300) reportedRenderRef.current.clear();
        clientRef.current?.markFirstRender(msgId);
      });
    });
  }, [messages]);

  const handleConnect = async () => {
    setBannerError(null);
    if (clientRef.current) {
      await clientRef.current.connect();
    }
  };

  const handleDisconnect = () => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
  };

  const handleStartMic = async () => {
    setBannerError(null);
    if (clientRef.current) {
      try {
        await clientRef.current.startMic();
      } catch (err: any) {
        setBannerError(err.message || 'Failed to start microphone');
      }
    }
  };

  const handleStopMic = async () => {
    if (clientRef.current) {
      await clientRef.current.stopMic();
    }
  };

  const handleSendMessage = (text: string) => {
    if (clientRef.current) {
      clientRef.current.sendUserText(text);
    }
  };

  const handleClearConversation = () => {
    setMessages([]);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  const handleCopyFullDiagnostics = () => {
    if (!clientRef.current) return;

    const report = clientRef.current.generateFullReport();

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(report).then(
          () => {
            setIsDiagnosticsCopied(true);
            setTimeout(() => setIsDiagnosticsCopied(false), 2500);
          },
          () => {
            // Clipboard rejected -> Fallback modal
            setFallbackReportText(report);
            setIsFallbackModalOpen(true);
          }
        );
      } else {
        setFallbackReportText(report);
        setIsFallbackModalOpen(true);
      }
    } catch {
      setFallbackReportText(report);
      setIsFallbackModalOpen(true);
    }
  };

  const isStreaming = messages.some((m) => m.status === 'streaming');

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-zinc-100 font-sans antialiased selection:bg-indigo-500/30">
      {/* Top Header */}
      <Header
        status={status}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onClearConversation={handleClearConversation}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        onToggleDebugDrawer={() => setIsDebugDrawerOpen((prev) => !prev)}
        isDebugDrawerOpen={isDebugDrawerOpen}
        eventCount={logs.length}
        onCopyFullDiagnostics={handleCopyFullDiagnostics}
        isDiagnosticsCopied={isDiagnosticsCopied}
      />

      {/* Backend & Ephemeral Token Status Ribbon */}
      <ConfigStatus
        tokenInfo={tokenInfo}
        backendStatus={backendStatus}
        onRefreshBackendStatus={fetchBackendStatus}
        isLoadingBackend={isLoadingBackend}
      />

      {/* Stage 2 Customer Microphone Control & Audio Level Meter */}
      <MicControlBar
        micState={micState}
        micHealth={micHealth}
        micLevel={micLevel}
        isCustomerSpeaking={isCustomerSpeaking}
        isConnected={status === 'connected'}
        onStartMic={handleStartMic}
        onStopMic={handleStopMic}
      />

      {/* Error alert banner if any */}
      {bannerError && (
        <div className="bg-rose-950/70 border-b border-rose-800/80 px-4 py-2 text-xs text-rose-300 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-400 shrink-0" />
            <span>{bannerError}</span>
          </div>
          <button
            onClick={() => setBannerError(null)}
            className="text-rose-400 hover:text-rose-200 text-xs underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Conversation Area */}
      <ConversationView
        messages={messages}
        onSelectPrompt={handleSendMessage}
        isConnected={status === 'connected'}
        isMicActive={micState === 'recording' || micState === 'muted'}
        onStartMic={handleStartMic}
      />

      {/* Input Bar at bottom (preserves text-input testing mode) */}
      <InputBar
        onSendMessage={handleSendMessage}
        isConnected={status === 'connected'}
        isStreaming={isStreaming}
      />

      {/* Side Debug Event Drawer */}
      <EventLogDrawer
        logs={logs}
        isOpen={isDebugDrawerOpen}
        onClose={() => setIsDebugDrawerOpen(false)}
        onClearLogs={handleClearLogs}
        onCopyFullDiagnostics={handleCopyFullDiagnostics}
        isDiagnosticsCopied={isDiagnosticsCopied}
      />

      {/* Verification Test Suite Diagnostics Modal */}
      <TestDiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        backendStatus={backendStatus}
        tokenInfo={tokenInfo}
        isConnected={status === 'connected'}
      />

      {/* Fallback Textarea Modal for Copy Diagnostics when Clipboard API is restricted */}
      <FallbackDiagnosticsModal
        isOpen={isFallbackModalOpen}
        onClose={() => setIsFallbackModalOpen(false)}
        reportText={fallbackReportText}
      />
    </div>
  );
}
