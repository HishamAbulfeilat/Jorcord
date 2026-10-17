import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error('[ui] render error', err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 bg-chat p-6 text-center text-normal">
        <h2 className="text-xl font-bold text-header">Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</h2>
        <p className="max-w-md text-sm text-muted">{this.state.err.message}</p>
        <button className="btn btn-primary" onClick={() => this.setState({ err: null })}>Try again</button>
        <button className="btn btn-secondary" onClick={() => location.reload()}>Reload app</button>
      </div>
    );
  }
}
