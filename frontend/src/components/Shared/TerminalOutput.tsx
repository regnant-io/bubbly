import React from 'react';
import { useStore } from '../../store';
import { ColorizedLog, stripAnsi, toneOf } from '../../utils/logColor';
import './TerminalOutput.css';

interface TerminalOutputProps {
  terminalId: string;
  command: string;
  output: Array<{ stream: 'stdout' | 'stderr'; content: string }>;
  exitCode?: number;
  startTime: number;
  duration?: number;
  expanded?: boolean;
}

export function TerminalOutput({
  terminalId,
  command,
  output,
  exitCode,
  startTime,
  duration,
  expanded = true,
}: TerminalOutputProps) {
  const toggleTerminalExpanded = useStore((state) => state.toggleTerminalExpanded);

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  };

  const handleToggle = () => {
    toggleTerminalExpanded(terminalId);
  };

  const isRunning = exitCode === undefined;
  const hasError = exitCode !== undefined && exitCode !== 0;

  return (
    <div className={`terminal-output ${isRunning ? 'running' : ''} ${hasError ? 'error' : ''}`}>
      <div className="terminal-header" onClick={handleToggle}>
        <div className="terminal-header-left">
          <span className="terminal-icon">▶</span>
          <span className="terminal-command">{command}</span>
        </div>
        <div className="terminal-header-right">
          <span className="terminal-time">{formatTime(startTime)}</span>
          {duration !== undefined && (
            <span className="terminal-duration">{formatDuration(duration)}</span>
          )}
          {exitCode !== undefined && (
            <span className={`terminal-exit-code ${hasError ? 'error' : 'success'}`}>
              exit {exitCode}
            </span>
          )}
          {isRunning && <span className="terminal-running">running...</span>}
          <button className="terminal-toggle" aria-label={expanded ? 'Collapse' : 'Expand'}>
            {expanded ? '▼' : '▶'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="terminal-content">
          <pre className="terminal-output-text">
            {/*
              stderr is not the same thing as an error, and it never was. Half of
              npm, all of tsc's progress and every progress bar in the world go
              to stderr, and painting the whole stream red taught people to
              ignore red. So the STREAM sets a floor (stderr is at least
              noteworthy) and the LINE decides the rest.
            */}
            {output.map((line, index) => (
              <div
                key={index}
                className={`terminal-line ${
                  line.stream === 'stderr' && toneOf(stripAnsi(line.content)) === 'plain' ? 'stderr-plain' : 'stdout'
                }`}
              >
                <ColorizedLog text={line.content} />
              </div>
            ))}
            {output.length === 0 && isRunning && (
              <div className="terminal-line stdout terminal-waiting">Waiting for output…</div>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
