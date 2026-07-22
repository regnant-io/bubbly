import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Optional label so the fallback can say which region failed. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors in its subtree so a single bad message, tool
 * payload, or malformed event can't white-screen the entire app. Shows a small
 * recoverable panel instead, with a reset that re-mounts the subtree.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught an error', this.props.label, error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-xl border border-red-agent/40 bg-error-bg p-4 text-sm">
          <p className="font-medium text-text mb-1">
            Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}.
          </p>
          <p className="text-text-muted text-xs mb-3 break-words">{this.state.error.message}</p>
          <button
            onClick={this.reset}
            className="px-3 py-1.5 rounded-lg border border-border hover:border-accent hover:bg-accent/10 text-xs text-text transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
