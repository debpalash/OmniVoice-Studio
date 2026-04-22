import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

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

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 32, fontFamily: 'var(--font-sans)',
      }}>
        <div style={{
          maxWidth: 520, width: '100%',
          padding: 22, textAlign: 'center',
          background: 'var(--chrome-bg)',
          border: '1px solid color-mix(in srgb, var(--chrome-severity-err) 35%, transparent)',
          borderLeft: '2px solid var(--chrome-severity-err)',
          borderRadius: 'var(--chrome-radius-pill)',
          boxShadow: 'none',
        }}>
          <AlertCircle size={32} color="var(--chrome-severity-err)" style={{ marginBottom: 10 }} />
          <h2 style={{
            fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: '1.6rem', fontWeight: 400,
            color: 'var(--chrome-fg)', margin: '0 0 6px', letterSpacing: '-0.01em',
          }}>
            This tab hit a snag.
          </h2>
          <p style={{ color: 'var(--chrome-fg-muted)', fontSize: '0.82rem', margin: '0 0 12px', lineHeight: 1.5 }}>
            Don't worry — the rest of the app still works. You can switch tabs, or try again below.
          </p>
          <pre style={{
            textAlign: 'left', fontSize: '0.72rem', color: 'var(--chrome-severity-err)',
            background: 'var(--chrome-hover-bg)', padding: '8px 10px', borderRadius: 'var(--chrome-radius-pill)',
            border: '1px solid var(--chrome-border)',
            maxHeight: 140, overflow: 'auto', margin: '0 0 14px',
            fontFamily: 'var(--font-mono)',
          }}>{msg}</pre>
          <button
            onClick={this.reset}
            className="btn-primary"
            style={{
              padding: '6px 14px', fontSize: '0.78rem', fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      </div>
    );
  }
}
