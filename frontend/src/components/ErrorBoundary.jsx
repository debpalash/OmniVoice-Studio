import React from 'react';
import { AlertCircle, BookOpen, RefreshCw } from 'lucide-react';
import { classifyError, openDocsFor } from '../utils/errorDocsMap';
import './WaveformErrorBoundary.css';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface via console.error so it reaches our ring buffer (Settings > Logs > Frontend).
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.name || 'anon'}]`, error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  openDocs = async () => {
    const cls =
      this.state.error?.errorClass /* explicit hint from the thrower */ ||
      classifyError(this.state.error);
    try {
      await openDocsFor(cls);
    } catch (err) {
      // openExternal already falls back to window.open; swallow any
      // remaining failure so the error boundary itself never throws.
      // eslint-disable-next-line no-console
      console.warn('[ErrorBoundary] openDocsFor failed', err);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div className="errbnd-wrap">
        <div className="errbnd-card">
          <AlertCircle size={32} color="var(--chrome-severity-err)" className="errbnd-icon" />
          <h2 className="errbnd-title">
            This tab hit a snag.
          </h2>
          <p className="errbnd-desc">
            Don't worry — the rest of the app still works. You can switch tabs, or try again below.
          </p>
          <pre className="errbnd-trace">{msg}</pre>
          <div className="errbnd-actions">
            <button
              onClick={this.reset}
              className="btn-primary errbnd-retry"
            >
              <RefreshCw size={12} /> Try again
            </button>
            <button
              type="button"
              onClick={this.openDocs}
              className="btn-secondary errbnd-docs"
              title="Open the docs page for this error in your browser"
            >
              <BookOpen size={12} /> Open docs for this error
            </button>
          </div>
        </div>
      </div>
    );
  }
}
