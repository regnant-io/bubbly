import React from 'react';
import { useStore } from '../../store';
import { FileBox, ArrowRight } from '../Shared/icons';

const KIND_LABEL: Record<string, string> = {
  markdown: 'Document',
  html: 'Page',
  code: 'Code',
  svg: 'Diagram',
  mermaid: 'Diagram',
  json: 'Data',
};

/**
 * The transcript's stand-in for a document the agent wrote.
 *
 * It is deliberately small and says almost nothing about the contents: title,
 * kind, size, version. That restraint IS the feature — the reason artifacts
 * exist is that a two-thousand-word plan pasted into the chat pushes the
 * conversation off the screen. A card that previewed the first paragraph would
 * quietly reintroduce the problem it was built to solve.
 */
export function ArtifactCard({ artifactId }: { artifactId: string }) {
  const artifact = useStore((s) => s.artifacts.find((a) => a.id === artifactId));
  const setActiveArtifact = useStore((s) => s.setActiveArtifact);
  const openRightContext = useStore((s) => s.openRightContext);

  if (!artifact) return null;
  const latest = artifact.versions[artifact.versions.length - 1];
  const lines = (latest?.content ?? '').split('\n').length;

  const open = () => {
    setActiveArtifact(artifact.id);
    openRightContext('artifacts');
  };

  return (
    <button
      onClick={open}
      title="Open in the Artifacts panel"
      className="group w-full text-left my-2 px-3 py-2.5 rounded-xl border border-accent/25 bg-accent/[0.05] hover:border-accent/50 hover:bg-accent/10 transition-colors animate-fade-in"
    >
      <div className="flex items-center gap-2">
        <FileBox size={15} className="text-accent-bright shrink-0" />
        <span className="text-sm font-medium text-text truncate flex-1">{artifact.title}</span>
        {artifact.versions.length > 1 && (
          <span className="shrink-0 text-[10px] tabular-nums text-accent-bright px-1.5 py-px rounded bg-accent/15">
            v{latest?.version}
          </span>
        )}
        <ArrowRight size={13} className="shrink-0 text-text-dim/50 group-hover:text-accent-bright transition-colors" />
      </div>
      <div className="mt-0.5 pl-[23px] text-[11px] text-text-dim">
        {KIND_LABEL[artifact.kind] ?? artifact.kind}
        {artifact.language ? ` · ${artifact.language}` : ''}
        {' · '}{lines.toLocaleString()} line{lines === 1 ? '' : 's'}
        {latest?.note ? ` · ${latest.note}` : ''}
      </div>
    </button>
  );
}
