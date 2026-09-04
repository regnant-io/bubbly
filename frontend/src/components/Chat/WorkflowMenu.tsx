import React from 'react';
import {
  Code2, Bug, Search, BookOpen, Map as MapIcon, ShieldCheck, CheckCircle, Wrench, Zap,
  GitBranch, FileText, RefreshCw, ListTree, FolderPlus, ChevronRight, X,
  MessageSquare, Square, Clock, ClipboardList, Monitor, Server, Gauge, FilePlus, ChevronUp,
} from '../Shared/icons';
import type { ClientCommandDef } from '../../utils/clientCommands';

/**
 * The slash-command picker — now a workflow launcher.
 *
 * WHAT CHANGED AND WHY IT MATTERS
 *
 * The old menu inserted a text prefix: `/bugfix` became "Debug and fix: ". That
 * is a shortcut for typing three words, dressed up as a feature.
 *
 * A workflow is a prompt PROGRAM defined on the server — phases, evidence
 * requirements, scope limits, a seeded plan. The client's job is only to collect
 * its arguments and name it; the expansion happens in one place so the desktop
 * app and the CLI cannot disagree about what `/fix` means.
 *
 * The two-step shape (pick a workflow → fill its fields) exists because the
 * arguments are the part that makes a workflow specific. `/loop` without a goal
 * and a budget is not a loop, it is a runaway.
 */

export interface WorkflowParam {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  default?: string;
  kind?: 'text' | 'number' | 'duration';
  hint?: string;
}

export interface WorkflowInfo {
  id: string;
  command: string;
  name: string;
  description: string;
  group: string;
  icon: string;
  params: WorkflowParam[];
}

const ICONS: Record<string, typeof Code2> = {
  Code2, Bug, Search, BookOpen, Map: MapIcon, ShieldCheck, CheckCircle, Wrench, Zap,
  GitBranch, FileText, RefreshCw, ListTree, FolderPlus,
  MessageSquare, Square, Clock, ClipboardList, Monitor, Server, Gauge, FilePlus, ChevronUp, X,
};

const GROUP_LABELS: Record<string, string> = {
  // Client commands
  session: 'Session',
  agent: 'The agent',
  context: 'Context',
  project: 'This project',
  settings: 'Settings',
  help: 'Help',
  // Workflows
  build: 'Build',
  fix: 'Fix',
  understand: 'Understand',
  quality: 'Quality',
  ship: 'Ship',
  run: 'Run',
};

/**
 * ONE PICKER, TWO KINDS OF COMMAND.
 *
 * A workflow is a prompt program the server expands; a client command is an
 * action this app performs. They are genuinely different things, and the menu
 * says so with a tag rather than by hiding one of them somewhere else — a
 * person typing `/` wants to see everything `/` can do, and having to remember
 * which menu `/model` lives in is precisely the failure a command palette
 * exists to prevent.
 *
 * Client commands come first because they are instant and reversible; a
 * workflow starts real work.
 */
type MenuEntry =
  | { kind: 'command'; command: ClientCommandDef }
  | { kind: 'workflow'; workflow: WorkflowInfo };

interface WorkflowMenuProps {
  /** What the user has typed, including the leading slash. */
  query: string;
  onRun: (workflow: WorkflowInfo, args: Record<string, string>) => void;
  /** Run a client command — see utils/clientCommands. */
  onRunCommand: (command: string, arg: string) => void;
  onClose: () => void;
}

export function WorkflowMenu({ query, onRun, onRunCommand, onClose }: WorkflowMenuProps) {
  const [workflows, setWorkflows] = React.useState<WorkflowInfo[]>([]);
  const [commands, setCommands] = React.useState<ClientCommandDef[]>([]);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [configuring, setConfiguring] = React.useState<WorkflowInfo | null>(null);
  const [args, setArgs] = React.useState<Record<string, string>>({});
  const firstFieldRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    let cancelled = false;
    // Both lists come from the server so this menu and the terminal client
    // cannot end up offering different commands under the same names.
    void Promise.all([
      fetch('/api/settings/workflows').then((r) => r.json()).catch(() => ({ workflows: [] })),
      fetch('/api/settings/commands?surface=desktop').then((r) => r.json()).catch(() => ({ commands: [] })),
    ]).then(([w, c]) => {
      if (cancelled) return;
      setWorkflows(w.workflows ?? []);
      setCommands(c.commands ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  // Only the first word is the command; "/fix the login" filters on "fix".
  const typed = query.replace(/^\//, '');
  const term = typed.split(/\s/)[0].toLowerCase().trim();
  const trailing = typed.slice(term.length).trim();

  const entries = React.useMemo<MenuEntry[]>(() => {
    const matchesCommand = (c: ClientCommandDef) =>
      !term ||
      c.command.includes(term) ||
      c.aliases?.some((a) => a.includes(term)) ||
      c.title.toLowerCase().includes(term) ||
      c.description.toLowerCase().includes(term);
    const matchesWorkflow = (w: WorkflowInfo) =>
      !term ||
      w.command.includes(term) ||
      w.name.toLowerCase().includes(term) ||
      w.description.toLowerCase().includes(term);
    return [
      ...commands.filter(matchesCommand).map((command) => ({ kind: 'command' as const, command })),
      ...workflows.filter(matchesWorkflow).map((workflow) => ({ kind: 'workflow' as const, workflow })),
    ];
  }, [commands, workflows, term]);

  const filtered = entries;

  React.useEffect(() => { setSelectedIndex(0); }, [term]);

  /**
   * Open a workflow's argument form, pre-filling the FIRST required text field
   * with whatever the user already typed after the command.
   *
   * Typing "/fix the login is broken" and then being shown an empty form would
   * make the feature feel like it threw the sentence away.
   */
  const configure = React.useCallback((w: WorkflowInfo, trailing: string) => {
    const initial: Record<string, string> = {};
    for (const p of w.params) initial[p.name] = p.default ?? '';
    const firstText = w.params.find((p) => p.required && !p.options);
    if (firstText && trailing.trim()) initial[firstText.name] = trailing.trim();
    setArgs(initial);
    setConfiguring(w);
    setTimeout(() => firstFieldRef.current?.focus(), 30);
  }, []);

  /**
   * Pick an entry.
   *
   * A client command RUNS — there is nothing to configure, and making the user
   * confirm "/stop" through a form would be absurd. A workflow opens its
   * argument form, because a workflow without its arguments is not a workflow.
   */
  const choose = React.useCallback((entry: MenuEntry) => {
    if (entry.kind === 'command') {
      onClose();
      onRunCommand(entry.command.command, trailing);
      return;
    }
    configure(entry.workflow, trailing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, onRunCommand, trailing]);

  // Keyboard: arrows and Enter in the list, Escape everywhere.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (configuring) setConfiguring(null); else onClose();
        return;
      }
      if (configuring) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const chosen = filtered[selectedIndex];
        if (!chosen) return;
        e.preventDefault();
        choose(chosen);
      } else if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey) {
        const chosen = filtered[Number(e.key) - 1];
        if (!chosen) return;
        e.preventDefault();
        choose(chosen);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filtered, selectedIndex, configuring, onClose, query, configure]);

  const canRun = configuring
    ? configuring.params.every((p) => !p.required || (args[p.name] ?? '').trim())
    : false;

  const run = () => {
    if (!configuring || !canRun) return;
    onRun(configuring, args);
  };

  // --- Argument form -------------------------------------------------------
  if (configuring) {
    const Icon = ICONS[configuring.icon] ?? Code2;
    return (
      <div className="absolute bottom-full mb-2 left-0 right-0 z-50 card bg-surface-1 shadow-xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Icon size={14} className="text-accent-bright shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-text">{configuring.name}</div>
            <div className="text-[10px] text-text-dim truncate">{configuring.description}</div>
          </div>
          <button onClick={() => setConfiguring(null)} className="p-1 rounded hover:bg-surface-3 text-text-dim hover:text-text">
            <X size={12} />
          </button>
        </div>

        <div className="p-3 space-y-2.5 max-h-[320px] overflow-y-auto">
          {configuring.params.map((p, i) => (
            <div key={p.name}>
              <label className="block text-[10px] uppercase tracking-wide text-text-dim pb-1">
                {p.label}
                {p.required && <span className="text-accent-bright"> *</span>}
              </label>

              {p.options ? (
                <div className="flex gap-1.5">
                  {p.options.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => setArgs((a) => ({ ...a, [p.name]: opt }))}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-[11px] border transition-colors ${
                        (args[p.name] ?? p.default) === opt
                          ? 'border-accent bg-accent/10 text-accent-bright'
                          : 'border-border text-text-muted hover:border-border-bright'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              ) : (
                <input
                  ref={i === 0 ? firstFieldRef : undefined}
                  type={p.kind === 'number' || p.kind === 'duration' ? 'number' : 'text'}
                  value={args[p.name] ?? ''}
                  onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canRun) { e.preventDefault(); run(); }
                  }}
                  placeholder={p.placeholder}
                  className="input w-full text-xs"
                />
              )}

              {p.hint && <p className="mt-1 text-[10px] text-text-dim leading-snug">{p.hint}</p>}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
          <span className="text-[10px] text-text-dim">
            Enter to run · Esc to go back
          </span>
          <button
            onClick={run}
            disabled={!canRun}
            className="ml-auto rounded-lg bg-accent/15 text-accent-bright px-3 py-1.5 text-[11px] font-medium
                       hover:bg-accent/25 disabled:opacity-40 transition-colors"
          >
            Run /{configuring.command}
          </button>
        </div>
      </div>
    );
  }

  // --- Workflow list -------------------------------------------------------
  if (filtered.length === 0) {
    return (
      <div className="absolute bottom-full mb-2 left-0 z-50 card bg-surface-1 shadow-xl px-3 py-2">
        <p className="text-xs text-text-dim">
          No workflow matches “{term}”. Press Escape to send it as an ordinary message.
        </p>
      </div>
    );
  }

  /** One row's shape, whichever kind it is. */
  const describe = (entry: MenuEntry) => (
    entry.kind === 'command'
      ? {
          key: `c:${entry.command.command}`,
          group: entry.command.group,
          command: entry.command.command,
          title: entry.command.title,
          description: entry.command.description,
          icon: entry.command.icon,
          argHint: entry.command.argHint,
          tag: 'do',
        }
      : {
          key: `w:${entry.workflow.id}`,
          group: entry.workflow.group,
          command: entry.workflow.command,
          title: entry.workflow.name,
          description: entry.workflow.description,
          icon: entry.workflow.icon,
          argHint: undefined as string | undefined,
          tag: 'run',
        }
  );

  // Group while preserving the server's ordering within each group.
  const groups = new Map<string, MenuEntry[]>();
  for (const entry of filtered) {
    const group = describe(entry).group;
    const list = groups.get(group);
    if (list) list.push(entry); else groups.set(group, [entry]);
  }

  let flatIndex = -1;

  return (
    <div className="absolute bottom-full mb-2 left-0 z-50 w-[440px] card bg-surface-1 shadow-xl overflow-hidden">
      <div className="max-h-[360px] overflow-y-auto py-1">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group}>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-dim">
              {GROUP_LABELS[group] ?? group}
            </div>
            {items.map((entry) => {
              const d = describe(entry);
              flatIndex += 1;
              const index = flatIndex;
              const Icon = ICONS[d.icon] ?? Code2;
              const active = index === selectedIndex;
              return (
                <button
                  key={d.key}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => choose(entry)}
                  className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                    active ? 'bg-accent/10' : 'hover:bg-surface-3'
                  }`}
                >
                  <Icon size={13} className={`mt-0.5 shrink-0 ${active ? 'text-accent-bright' : 'text-text-dim'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className={`text-xs font-mono ${active ? 'text-accent-bright' : 'text-text'}`}>
                        /{d.command}
                      </span>
                      {d.argHint && <span className="text-[10px] font-mono text-text-dim/70">{d.argHint}</span>}
                      <span className="text-[11px] text-text-muted truncate">{d.title}</span>
                    </div>
                    <p className="text-[10px] text-text-dim leading-snug truncate">{d.description}</p>
                  </div>
                  {/*
                    "do" vs "run" is the one distinction that matters here: a
                    client command happens instantly and is reversible; a
                    workflow starts the agent on real work. Saying so on the row
                    is cheaper than expecting anyone to learn which is which.
                  */}
                  <span
                    className={`shrink-0 mt-0.5 rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${
                      entry.kind === 'command' ? 'bg-surface-3 text-text-dim' : 'bg-accent/15 text-accent-bright'
                    }`}
                  >
                    {d.tag}
                  </span>
                  {index < 9 && (
                    <span className="shrink-0 text-[9px] text-text-dim/70 font-mono border border-border rounded px-1 mt-0.5">
                      {index + 1}
                    </span>
                  )}
                  {active && <ChevronRight size={11} className="shrink-0 text-accent-bright mt-1" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="border-t border-border px-3 py-1.5 text-[10px] text-text-dim">
        ↑↓ or 1–9 to choose · Enter to run · Esc to dismiss
      </div>
    </div>
  );
}
