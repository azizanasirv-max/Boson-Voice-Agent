import React, { useRef, useState } from 'react';
import { Check, Copy, FileText, X } from 'lucide-react';

interface FallbackDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  reportText: string;
}

export const FallbackDiagnosticsModal: React.FC<FallbackDiagnosticsModalProps> = ({
  isOpen,
  onClose,
  reportText,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleSelectAllAndCopy = () => {
    if (textareaRef.current) {
      textareaRef.current.select();
      try {
        navigator.clipboard.writeText(reportText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-3xl bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/80">
          <div className="flex items-center gap-2.5">
            <FileText className="w-5 h-5 text-indigo-400" />
            <div>
              <h2 className="text-sm font-bold text-zinc-100">Full Diagnostic Export Report</h2>
              <p className="text-xs text-zinc-400">
                Select all and copy text below to share complete session telemetry
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="p-4 flex-1 overflow-hidden flex flex-col space-y-3">
          <textarea
            ref={textareaRef}
            readOnly
            value={reportText}
            className="w-full flex-1 min-h-[360px] p-3 text-xs font-mono bg-zinc-950 text-zinc-200 border border-zinc-800 rounded-xl focus:outline-none focus:border-indigo-500 selection:bg-indigo-500/40 resize-none"
          />
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-zinc-800 flex items-center justify-between bg-zinc-900/80">
          <span className="text-xs text-zinc-400 font-mono">
            Length: {reportText.length} characters (API secrets &amp; audio Base64 redacted)
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSelectAllAndCopy}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-emerald-400" />
                  <span>Copied to Clipboard!</span>
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  <span>Select All &amp; Copy</span>
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-white rounded-xl bg-zinc-800 hover:bg-zinc-700 transition-all cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
