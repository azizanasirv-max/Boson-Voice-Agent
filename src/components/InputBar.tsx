import React, { useRef, useState, KeyboardEvent } from 'react';
import { CornerDownLeft, Send, Sparkles } from 'lucide-react';

interface InputBarProps {
  onSendMessage: (text: string) => void;
  isConnected: boolean;
  isStreaming: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({
  onSendMessage,
  isConnected,
  isStreaming,
}) => {
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (!inputText.trim() || !isConnected) return;
    onSendMessage(inputText);
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    // Auto-adjust height up to 160px
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(160, textareaRef.current.scrollHeight)}px`;
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-900/90 backdrop-blur-md p-4">
      <div className="max-w-3xl mx-auto">
        <div className="relative rounded-xl bg-zinc-950 border border-zinc-800 focus-within:border-indigo-500/80 transition-colors shadow-inner">
          <textarea
            ref={textareaRef}
            rows={1}
            value={inputText}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={!isConnected}
            placeholder={
              isConnected
                ? 'Type a message to send to Higgs Realtime (Enter to send, Shift+Enter for new line)...'
                : 'Connect to Higgs Realtime above to send text messages...'
            }
            className="w-full bg-transparent px-4 py-3.5 pr-24 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed max-h-40"
          />

          <div className="absolute right-2.5 bottom-2.5 flex items-center gap-1.5">
            <button
              onClick={handleSend}
              disabled={!isConnected || !inputText.trim() || isStreaming}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white shadow-xs transition-all cursor-pointer"
            >
              <span>Send</span>
              <Send className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between text-[11px] text-zinc-500 mt-2 px-1">
          <div className="flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-indigo-400" />
            <span>Sends: <code className="text-zinc-400">conversation.item.create</code> + <code className="text-zinc-400">response.create</code></span>
          </div>
          <div className="flex items-center gap-1">
            <span>Press <kbd className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-400 font-mono">Enter ↵</kbd> to send</span>
          </div>
        </div>
      </div>
    </div>
  );
};
