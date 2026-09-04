import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Send, Square, Paperclip, X, FileText, ChevronUp } from '../Shared/icons';
import { ModelSelector } from './ModelSelector';
import { SourcePicker } from './SourcePicker';
import { GitDiffCounter } from './GitDiffCounter';
import { ThreadTypeSelector } from './ThreadTypeSelector';
import { ContextGauge } from './ContextGauge';
import { WorkflowMenu, type WorkflowInfo } from './WorkflowMenu';
import { LoopBanner } from './LoopBanner';
import { PermissionPicker } from './PermissionPicker';
import { RunTimer } from './RunTimer';
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
  /**
   * Say something WHILE the agent is working.
   *
   * Returns false when the queue is full. Separate from onSend because the two
   * genuinely differ: a normal send starts a turn, a queued one joins the turn
   * already in flight and is only read at its next step boundary.
   */
  onQueue?: (message: string) => boolean;
  /**
   * Run a workflow instead of sending prose. The COMMAND and its arguments are
   * sent; the expansion into a real prompt happens on the server, so every
   * client agrees about what a workflow does.
   */
  onRunWorkflow?: (command: string, args: Record<string, string>, label: string) => void;
  /**
   * Run a CLIENT command — /model, /status, /new.
   *
   * Separate from onRunWorkflow because the two are genuinely different: a
   * workflow is a prompt the server expands and the agent then works on; a
   * client command is an action this app takes, instantly, without the model
   * being involved at all.
   */
  onRunCommand?: (command: string, arg: string) => void;
  onStop: () => void;
  isRunning: boolean;
  disabled?: boolean;
  placeholder?: string;
}

function nano() { return Math.random().toString(36).slice(2, 9); }

export function ChatInput({ onSend, onQueue, onRunWorkflow, onRunCommand, onStop, isRunning, disabled, placeholder }: ChatInputProps) {
  // Draft is persisted in the store so a refresh never loses typed content.
  const chatDraft = useStore((s) => s.chatDraft);
  const setChatDraft = useStore((s) => s.setChatDraft);
  const pendingMessages = useStore((s) => s.pendingMessages);
  const pendingAttachment = useStore((s) => s.pendingAttachment);
  const setPendingAttachment = useStore((s) => s.setPendingAttachment);
  const dismissPendingMessage = useStore((s) => s.dismissPendingMessage);
  const queuedCount = pendingMessages.filter((m) => m.status === 'queued').length;
  const queueFull = queuedCount >= 3;
  const { activeModelSupportsVision } = useModels();
  const [value, setValue] = useState(chatDraft);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pastedBlocks, setPastedBlocks] = useState<PastedBlock[]>([]);
  const [viewing, setViewing] = useState<PastedBlock | null>(null);
  const [visionWarning, setVisionWarning] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [slashMenuPosition, setSlashMenuPosition] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const optionsPanelRef = useRef<HTMLDivElement>(null);

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

  /**
   * An attachment handed in from outside the composer (/paste, a drop).
   *
   * Consumed and cleared immediately: leaving it in the store would re-attach
   * the same image every time this component remounted, which is exactly the
   * kind of ghost that is impossible to explain afterwards.
   */
  useEffect(() => {
    if (!pendingAttachment) return;
    setAttachments((a) => [...a, pendingAttachment]);
    if (pendingAttachment.isImage && !activeModelSupportsVision) setVisionWarning(true);
    setPendingAttachment(null);
    textareaRef.current?.focus();
  }, [pendingAttachment, setPendingAttachment, activeModelSupportsVision]);

  // Click outside to close options panel
  useEffect(() => {
    if (!showOptions) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (optionsPanelRef.current && !optionsPanelRef.current.contains(e.target as Node) && composerRef.current && !composerRef.current.contains(e.target as Node)) {
        setShowOptions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showOptions]);

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
    if (!msg && attachments.length === 0 && pastedBlocks.length === 0) return;

    /*
     * A RUNNING AGENT IS NOT A CLOSED DOOR.
     *
     * The composer used to disable itself for the whole of a turn, which is
     * precisely backwards: the moment you most need to say something ("not that
     * file", "also add the tests") is the moment you are watching the agent do
     * the wrong thing. Your only options were to sit on your hands or press
     * Stop and lose the turn.
     *
     * So a message sent mid-run is QUEUED against the thread and handed to the
     * running loop at its next step boundary. Attachments are the one thing
     * that cannot come along — they are folded into a prompt by the caller, and
     * a queued message is plain text — so those still wait for the turn to end.
     */
    if (isRunning) {
      if (!onQueue || attachments.length > 0) return;
      const pastedForQueue = pastedBlocks
        .map((p, i) => `\n\n--- Pasted content ${i + 1} ---\n${p.content}\n--- end ---`)
        .join('');
      if (!onQueue(msg + pastedForQueue)) return;
      setValue('');
      setChatDraft('');
      setPastedBlocks([]);
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      return;
    }

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
    setShowOptions(false);
  }, [value, attachments, pastedBlocks, isRunning, onSend, onQueue, setChatDraft]);

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
      // Let slash menu handle its own keyboard events
      if (showSlashMenu && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        // SlashCommandMenu will handle these
        return;
      }
      
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, showSlashMenu]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setValue(v);
    setChatDraft(v); // persist on every keystroke
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    
    // A leading slash opens the workflow picker. It stays open once a space is
    // typed, because "/fix the login is broken" should still reach the picker —
    // the trailing text becomes the workflow's first argument rather than
    // dismissing the menu, which is what the old first-word-only check did.
    setShowSlashMenu(v.trimStart().startsWith('/'));
  };

  const handleRunWorkflow = (workflow: WorkflowInfo, args: Record<string, string>) => {
    setShowSlashMenu(false);
    setValue('');
    setChatDraft('');
    // A readable label for the transcript: the user should see what they ran,
    // not the several hundred words the workflow expanded into.
    const primary = workflow.params.find((p) => p.required && !p.options);
    const detail = primary ? args[primary.name] : '';
    const label = detail ? `/${workflow.command} ${detail}` : `/${workflow.command}`;
    onRunWorkflow?.(workflow.command, args, label);
    textareaRef.current?.focus();
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
      <div className="mx-auto w-full max-w-2xl relative">
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

      {/*
        MESSAGES WAITING FOR THE AGENT.
        Shown as their own chips rather than as transcript bubbles, because
        they have not been read yet — putting them in the transcript would
        claim the agent had seen them. They become real bubbles at the exact
        point the agent reads them.
      */}
      {pendingMessages.length > 0 && (
        <div className="mb-2 space-y-1">
          {pendingMessages.map((m) => (
            <div
              key={m.id}
              className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                m.status === 'rejected'
                  ? 'border-amber-agent/40 bg-warning-bg text-text'
                  : 'border-accent/25 bg-accent/8 text-text-muted'
              }`}
            >
              <span className={`shrink-0 mt-px text-[10px] font-semibold uppercase tracking-wide ${
                m.status === 'rejected' ? 'text-amber-agent' : 'text-accent-bright'
              }`}>
                {m.status === 'rejected' ? 'not sent' : 'queued'}
              </span>
              <span className="flex-1 min-w-0 line-clamp-2 break-words">{m.text}</span>
              {m.reason && <span className="shrink-0 text-[10px] text-text-dim max-w-[40%] truncate" title={m.reason}>{m.reason}</span>}
              <button
                onClick={() => {
                  if (m.status === 'rejected') { setValue(m.text); setChatDraft(m.text); }
                  dismissPendingMessage(m.id);
                }}
                className="shrink-0 p-0.5 rounded hover:bg-surface-3 text-text-dim hover:text-text"
                title={m.status === 'rejected' ? 'Put it back in the composer' : 'Dismiss'}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <p className="text-[10px] text-text-dim px-0.5">
            {queuedCount > 0
              ? `The agent reads ${queuedCount === 1 ? 'this' : 'these'} at its next step. Up to 3 can wait.`
              : 'Nothing is waiting.'}
          </p>
        </div>
      )}

      {/* SMS-style input block */}
      <div className="space-y-2">
        {/* A running loop reports itself here — otherwise it is indistinguishable
            from a very long ordinary run. */}
        <LoopBanner onStop={onStop} />

        {/* Top row: where the work happens, how much it may do, and how long
            it has been going. */}
        <div className="flex items-center justify-between gap-2">
          <SourcePicker variant="pill" />
          <div className="flex items-center gap-1">
            <PermissionPicker />
            <RunTimer />
          </div>
        </div>

        <div
          ref={composerRef}
          className={`relative flex items-end gap-2 rounded-2xl border bg-surface-1 shadow-sm px-3 py-2 transition-colors ${
            disabled ? 'border-border opacity-50' : 'border-border focus-within:border-accent/50'
          }`}
        >
        {/* Workflow picker, above the composer */}
        {showSlashMenu && onRunWorkflow && (
          <WorkflowMenu
            query={value.trimStart()}
            onRun={handleRunWorkflow}
            onRunCommand={(command, arg) => {
              // A client command consumes what was typed: the composer should
              // be empty afterwards, the way it is after sending a message.
              setShowSlashMenu(false);
              setValue('');
              setChatDraft('');
              if (textareaRef.current) textareaRef.current.style.height = 'auto';
              onRunCommand?.(command, arg);
              textareaRef.current?.focus();
            }}
            onClose={() => setShowSlashMenu(false)}
          />
        )}

        {/* Left: Attach button */}
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
          title={isRunning ? 'Attachments have to wait for the turn to finish' : 'Attach files or images'}
          className="p-1.5 shrink-0 rounded-lg text-text-dim hover:text-text hover:bg-surface-3 disabled:opacity-40 transition-colors"
        >
          <Paperclip size={18} />
        </button>

        {/* Center: Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          placeholder={placeholder ?? 'Message Bubbly…'}
          rows={1}
          spellCheck
          autoCapitalize="off"
          autoCorrect="off"
          lang="en"
          className="flex-1 resize-none bg-transparent text-sm text-text placeholder-text-dim
                     focus:outline-none leading-snug overflow-hidden py-1"
          style={{ 
            fieldSizing: 'content',
            minHeight: '28px',
            maxHeight: '200px'
          } as React.CSSProperties}
        />

        {/* Right: Options button or Send/Stop */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Options dropup button - always visible */}
          <button
            onClick={() => setShowOptions(!showOptions)}
            disabled={disabled}
            className="p-1.5 rounded-lg text-text-dim hover:text-text hover:bg-surface-3 disabled:opacity-40 transition-colors"
            title="Options"
          >
            <ChevronUp size={18} className={`transition-transform ${showOptions ? 'rotate-180' : ''}`} />
          </button>

          {isRunning ? (
            <>
              {/* Queue, not send. Enabled only when there is something to say
                  and room to say it — a disabled button with a reason beats a
                  live one that silently does nothing. */}
              <button
                onClick={handleSend}
                disabled={!value.trim() || queueFull || !onQueue}
                className="p-2 rounded-lg bg-accent/20 hover:bg-accent/30 text-accent-bright
                           disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                title={
                  queueFull ? 'Three messages are already waiting — the agent reads them at its next step'
                  : !value.trim() ? 'Type something to queue it for the running agent'
                  : 'Queue this for the agent (Enter)'
                }
              >
                <Send size={16} />
              </button>
              <button
                onClick={onStop}
                className="p-2 rounded-lg bg-error-bg hover:bg-error border border-red-agent/50
                           text-red-agent hover:text-text-bright flex items-center justify-center transition-colors"
                title="Stop agent"
              >
                <Square size={16} />
              </button>
            </>
          ) : (
            <button
              onClick={handleSend}
              disabled={(!value.trim() && attachments.length === 0 && pastedBlocks.length === 0) || disabled}
              className="p-2 rounded-lg bg-accent hover:bg-accent-bright disabled:opacity-40
                         disabled:cursor-not-allowed text-white flex items-center justify-center transition-colors"
              title="Send (Enter)"
            >
              <Send size={16} />
            </button>
          )}
        </div>

        {/* Options dropup panel */}
        {showOptions && !disabled && (
          <div ref={optionsPanelRef} className="absolute bottom-full left-0 right-0 mb-2 bg-surface-2 border border-border-bright rounded-xl shadow-2xl p-3 animate-fade-in z-[10]">
            <div className="grid grid-cols-2 gap-3">
              {/* Left column */}
              <div className="space-y-2">
                <div>
                  <label className="text-[10px] text-text-dim uppercase tracking-wider font-medium block mb-1.5">Model</label>
                  <ModelSelector />
                </div>
                <div>
                  <label className="text-[10px] text-text-dim uppercase tracking-wider font-medium block mb-1.5">Mode</label>
                  <ThreadTypeSelector />
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-text-dim uppercase tracking-wider font-medium">Context</label>
                  <ContextGauge />
                </div>
                <div className="pt-1">
                  <GitDiffCounter />
                </div>
              </div>
            </div>
          </div>
        )}
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
