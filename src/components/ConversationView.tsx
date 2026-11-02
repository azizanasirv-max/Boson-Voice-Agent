import React, { useEffect, useRef } from 'react';
import {
  Bot,
  Check,
  Copy,
  Keyboard,
  Mic,
  Radio,
  Sparkles,
  User,
} from 'lucide-react';
import type { ConversationMessage } from '../realtime/types';

interface ConversationViewProps {
  messages: ConversationMessage[];
  onSelectPrompt: (prompt: string) => void;
  isConnected: boolean;
  isMicActive: boolean;
  onStartMic: () => void;
}

export const ConversationView: React.FC<ConversationViewProps> = ({
  messages,
  onSelectPrompt,
  isConnected,
  isMicActive,
  onStartMic,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const samplePrompts = [
    "We manage Google Business Profiles for clients, but content takes too much time.",
    "Why would our agency pay $250 a month for LocalSignal Agency support?",
    "Do you guarantee our clients will rank in the Google 3-pack?",
    "Can LocalSignal manage 20 locations, and is there a volume discount?",
    "We're not interested right now.",
  ];

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
      {messages.length === 0 ? (
        <div className="max-w-2xl mx-auto py-8 text-center">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-zinc-800/80 border border-zinc-700 flex items-center justify-center text-emerald-400 mb-4 shadow-inner">
            <Radio className="w-7 h-7" />
          </div>
          <h2 className="text-lg font-bold text-zinc-100">
            LocalSignal Agency — Sales Copilot Interface
          </h2>
          <p className="text-sm text-zinc-400 mt-2 max-w-lg mx-auto">
            Jordan (AI Sales Assistant) listens to prospect audio and provides ready-to-speak phrases and coaching notes for the salesperson on the call.
          </p>

          <div className="mt-6 p-4 rounded-xl bg-zinc-900/80 border border-zinc-800 text-left text-xs space-y-2 text-zinc-300">
            <div className="font-semibold text-zinc-200 flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-emerald-400" />
              LocalSignal Agency Offer Facts &amp; Copilot Rules:
            </div>
            <ul className="list-disc list-inside space-y-1 text-zinc-400 pl-1 font-mono text-[11px]">
              <li><strong className="text-emerald-300">Standard Offer:</strong> $250/month for 2 client locations (white-label GBP support)</li>
              <li><strong className="text-emerald-300">Copilot Role:</strong> Silent advisor for human salesperson — outputs ready-to-speak text</li>
              <li><strong className="text-emerald-300">Factuality Guardrails:</strong> No false ranking guarantees, discounts, or unconfirmed claims</li>
              <li><strong className="text-emerald-300">Zero Audio Output:</strong> Output modality is strictly text (<code className="text-cyan-300">["text"]</code>)</li>
            </ul>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {!isMicActive ? (
              <button
                onClick={onStartMic}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-md shadow-emerald-600/20 transition-all cursor-pointer"
              >
                <Mic className="w-4 h-4" />
                <span>Start Customer Microphone</span>
              </button>
            ) : (
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-emerald-300 text-xs font-mono">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Microphone is Live — Speak prospect statement now
              </span>
            )}
          </div>

          <div className="mt-6">
            <p className="text-xs font-medium text-zinc-400 mb-2">Or test prospect statements with typed input:</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
              {samplePrompts.map((prompt, idx) => (
                <button
                  key={idx}
                  onClick={() => onSelectPrompt(prompt)}
                  className="p-3 text-xs rounded-lg bg-zinc-900 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white transition-all cursor-pointer flex items-start gap-2 text-left"
                >
                  <Keyboard className="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5" />
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg) => {
            const isCustomer = msg.role === 'user';
            const isStreaming = msg.status === 'streaming';
            const isSpoken = msg.inputMode === 'mic';
            const isInterrupted = msg.status === 'interrupted' || msg.text?.includes('[interrupted]');

            return (
              <div
                key={msg.id}
                className={`flex gap-3 ${isCustomer ? 'justify-end' : 'justify-start'}`}
              >
                {!isCustomer && (
                  <div className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center text-indigo-400 shrink-0 mt-1">
                    <Bot className="w-4 h-4" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] rounded-2xl p-4 transition-all ${
                    isCustomer
                      ? isSpoken
                        ? 'bg-emerald-950/70 border border-emerald-800/80 text-emerald-100 rounded-tr-xs shadow-md'
                        : 'bg-indigo-600 text-white rounded-tr-xs shadow-md'
                      : 'bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-tl-xs shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4 mb-1.5 text-[11px] opacity-80 font-mono">
                    <div className="flex items-center gap-1.5 font-sans font-semibold">
                      {isCustomer ? (
                        <div className="flex items-center gap-2 flex-wrap">
                          {isSpoken ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400">
                              <Mic className="w-3 h-3" />
                              Agency Prospect (Spoken)
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-indigo-200">
                              <Keyboard className="w-3 h-3" />
                              Agency Prospect (Typed)
                            </span>
                          )}
                          {msg.speechDurationMs !== undefined && (
                            <span className="text-[10px] text-zinc-400 font-mono font-normal">
                              ({(msg.speechDurationMs / 1000).toFixed(1)}s speech)
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-indigo-300 font-bold">Jordan (Sales Copilot Suggestion)</span>
                          {msg.latencyAfterSpeechEndedMs !== undefined && (
                            <span
                              className="inline-flex items-center gap-1 text-emerald-400 font-mono text-[10px] bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800/60"
                              title="Measured elapsed time from customer speech end to first suggestion text"
                            >
                              ⚡ First suggestion: {msg.latencyAfterSpeechEndedMs} ms after speech ended
                            </span>
                          )}
                          {isStreaming && (
                            <span className="inline-flex items-center gap-1 text-cyan-400 font-mono text-[10px] bg-cyan-950/80 px-1.5 py-0.2 rounded border border-cyan-800/60">
                              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                              generating
                            </span>
                          )}
                          {isInterrupted && (
                            <span className="text-[10px] text-amber-400 font-mono bg-amber-950/60 px-1.5 rounded border border-amber-800/60">
                              interrupted
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span title={isCustomer ? "Speech start time" : "Suggestion generation time"}>
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                      {msg.text && (
                        <button
                          onClick={() => copyText(msg.id, msg.text)}
                          title="Copy text"
                          className="p-1 hover:text-white transition-colors cursor-pointer"
                        >
                          {copiedId === msg.id ? (
                            <Check className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {msg.text ? (
                      msg.text
                    ) : isCustomer && isSpoken ? (
                      <span className="text-emerald-400/90 italic flex items-center gap-2 font-mono text-xs">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                        Listening &amp; transcribing prospect speech (higgs-stt-3.1)...
                      </span>
                    ) : (
                      <span className="text-zinc-500 italic flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-ping" />
                        Generating copilot response suggestion...
                      </span>
                    )}
                    {isStreaming && (
                      <span className="inline-block w-1.5 h-4 ml-1 bg-cyan-400 animate-pulse align-middle" />
                    )}
                  </div>
                </div>

                {isCustomer && (
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0 mt-1 ${
                      isSpoken ? 'bg-emerald-700' : 'bg-indigo-600'
                    }`}
                  >
                    {isSpoken ? <Mic className="w-4 h-4" /> : <User className="w-4 h-4" />}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};
