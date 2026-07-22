import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Paperclip, X, FileText } from '../Shared/icons';
import { ModelSelector } from './ModelSelector';
import { WorkspaceSelector } from './WorkspaceSelector';
import { ThreadTypeSelector } from './ThreadTypeSelector';
import { useStore } from '../../store';
import { useModels } from '../../hooks/useModels';

export interface Attachment {
  name: string;
  type: string;
  size: number;
  /** Text content for text files, or a data URL for images. */
  content: string;
  isImage: boolean;
}

/** A large pasted text block, shown as a chip instead of flooding the textarea. */
interface PastedBlock {
  id: string;
  content: string;
  lines: number;
}

/** Pastes longer than this become a collapsed "pasted content" chip. */
const PASTE_CHIP_THRESHOLD = 1200;

interface ChatInputProps {
  onSend: (message: string, attachments?: Attachment[]) => void;
  onStop: () => void;
  isRunning: boolean;
  disabled?: boolean;
  placeholder?: string;
}

function nano() { return Math.random().toString(36).slice(2, 9); }

export function ChatInput({ onSend, onStop, isRunning, disabled, placeholder }: ChatInputProps) {
  // Draft is persisted in the store so a refresh never loses typed content.
  const chatDraft = useStore((s) => s.chatDraft);
  const setChatDraft = useStore((s) => s.setChatDraft);
  const { activeModelSupportsVision } = useModels();
  const [value, setValue] = useState(chatDraft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
  const [viewing, setViewing] = useState<PastedBlock | null>(null);
  const [visionWarning, setVisionWarning] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Restore the persisted draft on mount (e.g. after a refresh).
  useEffect(() => {
    if (chatDraft && !value) {
      setValue(chatDraft);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync EXTERNAL draft changes (e.g. clicking an example prompt in the welcome
  // card) into the textarea. Only when the store value diverges from local, to
  // avoid clobbering active typing (keystrokes write the store synchronously).
  useEffect(() => {
    if (chatDraft !== value) {
      setValue(chatDraft);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; el.focus(); }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatDraft]);

  const handleSend = useCallback(() => {
    const msg = value.trim();
    if ((!msg && attachments.length === 0 && pastedBlocks.length === 0) || isRunning) return;
    // Fold any pasted blocks into the outgoing message so the agent sees them.
    const pastedText = pastedBlocks
      .map((p, i) => `\n\n--- Pasted content ${i + 1} ---\n${p.content}\n--- end ---`)
      .join('');
    const composed = msg + pastedText;
    setValue('');
    setChatDraft('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onSend(composed, attachments.length > 0 ? attachments : undefined);
    setAttachments([]);
    setPastedBlocks([]);
  }, [value, attachments, pastedBlocks, isRunning, onSend, setChatDraft]);

  const handleFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    Array.from(files).slice(0, 5).forEach((file) => {
      const isImage = file.type.startsWith('image/');
      if (isImage && !activeModelSupportsVision) setVisionWarning(true);
      const cap = isImage ? 4 * 1024 * 1024 : 256 * 1024;
      if (file.size > cap) {
        setAttachments((a) => [...a, { name: file.name, type: file.type, size: file.size, content: `[file too large: ${(file.size / 1024).toFixed(0)}KB]`, isImage }]);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setAttachments((a) => [...a, {
          name: file.name, type: file.type, size: file.size,
          content: String(reader.result ?? ''), isImage,
        }]);
      };
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
  }, [activeModelSupportsVision]);

  const removeAttachment = (i: number) => setAttachments((a) => a.filter((_, idx) => idx !== i));
  const removePasted = (id: string) => setPastedBlocks((p) => p.filter((b) => b.id !== id));

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    setChatDraft(v); // persist on every keystroke
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // Files (images, etc.) → attachments.
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      handleFiles(files);
      return;
    }
    // Very long text pastes → a collapsed chip (Claude-style) instead of
    // flooding the input. Short pastes go straight into the textarea.
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.length > PASTE_CHIP_THRESHOLD) {
      e.preventDefault();
      setPastedBlocks((p) => [...p, { id: nano(), content: text, lines: text.split('\n').length }]);
    }
  }, [handleFiles]);

  return (
    <div className="px-4 pb-3 pt-2">
      <div className="mx-auto w-full max-w-3xl">
      {visionWarning && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-agent/40 bg-warning-bg px-3 py-1.5 text-xs text-text">
          <span>The active model has no vision support — it won&rsquo;t be able to read this image. Switch models above to attach it properly.</span>
          <button onClick={() => setVisionWarning(false)} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text shrink-0" title="Dismiss">
            <X size={12} />
          </button>
        </div>
      )}
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((att, i) => (
            <div key={i} className="flex items-center gap-1.5 bg-surface-2 border border-border rounded-lg pl-1.5 pr-1 py-1 text-xs">
              {att.isImage ? (
                <img src={att.content} alt={att.name} className="w-6 h-6 rounded object-cover" />
              ) : (
                <Paperclip size={12} className="text-text-dim" />
              )}
              <span className="text-text-muted max-w-[140px] truncate">{att.name}</span>
              <button onClick={() => removeAttachment(i)} className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text" title="Remove">
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Pasted-content chips (large pastes) */}
      {pastedBlocks.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pastedBlocks.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setViewing(b)}
              className="group flex items-center gap-2 bg-surface-2 border border-border rounded-lg pl-2 pr-1.5 py-1.5 text-xs hover:border-accent/50 transition-colors"
              title="Click to view full pasted content"
            >
              <FileText size={13} className="text-accent-bright shrink-0" />
              <span className="text-text-muted">Pasted {i + 1}</span>
              <span className="text-text-dim">· {b.lines.toLocaleString()} lines · {(b.content.length / 1024).toFixed(1)} KB</span>
              <span
                onClick={(e) => { e.stopPropagation(); removePasted(b.id); }}
                className="p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text cursor-pointer"
                title="Remove"
              >
                <X size={11} />
              </span>
            </button>
          ))}
        </div>
      )}

      <div
        className={`flex flex-col rounded-xl border bg-surface-1 shadow-sm transition-colors ${
          disabled ? 'border-border opacity-50' : 'border-border focus-within:border-accent/50'
        }`}
      >
        {/* Text row */}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.cs,.css,.html,.yml,.yaml,.toml,.csv,.log"
            className="hidden"
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || isRunning}
            className="p-2 ml-1 mb-1 shrink-0 rounded-lg text-text-dim hover:text-text hover:bg-surface-3 disabled:opacity-40 transition-colors"
            title="Attach files or images"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled || isRunning}
            placeholder={placeholder ?? 'Message Bubbly… (Enter to send, Shift+Enter for newline)'}
            rows={1}
            // Native browser spellcheck: underlines misspellings and offers
            // corrections via the OS/Chromium right-click menu (offline, no
            // dictionary to ship). autoCapitalize off so code/paths aren't mangled.
            spellCheck
            autoCapitalize="off"
            autoCorrect="off"
            lang="en"
            className="flex-1 resize-none bg-transparent px-1 py-3 text-sm text-text placeholder-text-dim
                       focus:outline-none leading-relaxed min-h-[44px] max-h-[200px]"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
          />
          <div className="p-2 shrink-0">
            {isRunning ? (
              <button
                onClick={onStop}
                className="w-8 h-8 rounded-lg bg-error-bg hover:bg-error border border-red-agent/50
                           text-red-agent hover:text-text-bright flex items-center justify-center transition-colors"
                title="Stop agent"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={(!value.trim() && attachments.length === 0 && pastedBlocks.length === 0) || disabled}
                className="w-8 h-8 rounded-lg bg-accent hover:bg-accent-bright disabled:opacity-40
                           disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>

        {/* Toolbar row: workspace + model + history (left), hint (right) */}
        <div className="flex items-center justify-between px-1.5 pb-1.5 -mt-0.5 gap-2">
          <div className="flex items-center gap-0.5 min-w-0">
            <WorkspaceSelector />
            <span className="text-text-dim/40 select-none">·</span>
            <ModelSelector />
            <span className="text-text-dim/40 select-none">·</span>
            <ThreadTypeSelector />
          </div>
          <span className="text-[10px] text-text-dim pr-2 hidden sm:block shrink-0">Enter to send · Shift+Enter for newline</span>
        </div>
      </div>
      {/* AI disclaimer */}
      <p className="text-[11px] text-text-dim text-center mt-1.5">
        Bubbly can make mistakes. Review important changes.
      </p>
      {disabled && (
        <p className="text-xs text-red-agent mt-1 px-1 text-center">
          Set a workspace path in Settings first.
        </p>
      )}
      </div>

      {/* Pasted content modal */}
      {viewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6 animate-fade-in"
          onClick={() => setViewing(null)}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] rounded-2xl border border-border-bright bg-surface-1 shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <FileText size={15} className="text-accent-bright" />
                <span className="text-sm font-medium text-text">Pasted content</span>
                <span className="text-xs text-text-dim">{viewing.lines.toLocaleString()} lines · {(viewing.content.length / 1024).toFixed(1)} KB</span>
              </div>
              <button onClick={() => setViewing(null)} className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text" title="Close">
                <X size={15} />
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs font-mono text-text-muted whitespace-pre-wrap break-words leading-relaxed">
              {viewing.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
