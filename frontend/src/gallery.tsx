/**
 * DEV-ONLY component gallery (served at /gallery.html by the Vite dev server).
 *
 * Renders the chat's tool blocks against realistic content so they can be
 * designed and reviewed without needing a live agent run. Not part of the app
 * bundle — index.html never imports this.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { ToolIndicator } from './components/Shared/ToolIndicator';

const LONG_OUTPUT = Array.from({ length: 40 }, (_, i) =>
  `src/components/${['Nav', 'Hero', 'Footer', 'Card'][i % 4]}.tsx:${10 + i}:  const value = compute(${i});`
).join('\n');

const READ_FILES_OUTPUT = [
  '### src/hooks/useParallax.ts',
  'export default function useParallax(speed = 0.05) {',
  '  const ref = useRef<HTMLElement>(null);',
  '  return ref;',
  '}',
  '',
  '---',
  '',
  '### src/hooks/useScrollReveal.ts',
  'export default function useScrollReveal(key?: string) {',
  '  const [visible, setVisible] = useState(false);',
  '  return visible;',
  '}',
].join('\n');

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-text-dim mb-1">{title}</h2>
      {note && <p className="text-xs text-text-dim mb-3">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Gallery() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

  return (
    <div className="min-h-screen bg-surface-0 text-text">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-semibold">Tool block gallery</h1>
            <p className="text-sm text-text-dim">The chat transcript's building blocks, in isolation.</p>
          </div>
          <button
            onClick={toggle}
            className="rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-xs hover:bg-surface-2"
          >
            {theme === 'light' ? 'Dark' : 'Light'} theme
          </button>
        </div>

        <Section title="A realistic run" note="How a sequence actually reads in the transcript.">
          <ToolIndicator tool="get_repo_map" status="complete" duration={13} result={'Indexed 26 files'} />
          <ToolIndicator
            tool="read_file"
            status="complete"
            duration={8}
            args={{ path: 'src/hooks/useParallax.ts' }}
            result={'export default function useParallax(speed = 0.05) {\n  // ...\n}'}
          />
          <ToolIndicator
            tool="grep_search"
            status="complete"
            duration={124}
            args={{ query: 'addEventListener' }}
            result={LONG_OUTPUT}
          />
          <ToolIndicator
            tool="edit_file"
            status="complete"
            duration={41}
            args={{ path: 'src/hooks/useParallax.ts' }}
            diff={[{ path: 'src/hooks/useParallax.ts', type: 'modify', additions: 24, deletions: 7 }]}
            result={'Edited src/hooks/useParallax.ts'}
          />
          <ToolIndicator tool="run_command" status="executing" args={{ command: 'npm run build' }} />
        </Section>

        <Section title="States">
          <ToolIndicator tool="read_file" status="preparing" args={{ path: 'src/App.tsx' }} />
          <ToolIndicator tool="write_file" status="executing" args={{ path: 'src/components/Nav.tsx' }} />
          <ToolIndicator
            tool="write_file"
            status="complete"
            duration={2345}
            args={{ path: 'src/components/very/deeply/nested/ComponentName.tsx' }}
            diff={[{ path: 'x', type: 'create', additions: 120, deletions: 0 }]}
            result={'Wrote 120 lines'}
          />
          <ToolIndicator
            tool="delete_file"
            status="complete"
            duration={12}
            args={{ path: 'src/legacy/old.ts' }}
            result={'Error: ENOENT: no such file or directory, unlink of src/legacy/old.ts'}
          />
          <ToolIndicator tool="find_files" status="complete" duration={31} args={{ pattern: '**/*.test.ts' }} result={'no matches found'} />
          <ToolIndicator
            tool="edit_file"
            status="complete"
            duration={77}
            args={{ path: 'src/App.tsx' }}
            repeatCount={4}
            diff={[{ path: 'src/App.tsx', type: 'modify', additions: 3, deletions: 18 }]}
            result={'Applied 4 consecutive edits'}
          />
        </Section>

        <Section title="Expanded output" note="Click a row to expand. Multi-file reads split per file.">
          <ToolIndicator tool="read_files" status="complete" duration={22} result={READ_FILES_OUTPUT} />
          <ToolIndicator tool="run_command" status="complete" duration={8421} args={{ command: 'npm test' }} result={LONG_OUTPUT} />
        </Section>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Gallery />);
