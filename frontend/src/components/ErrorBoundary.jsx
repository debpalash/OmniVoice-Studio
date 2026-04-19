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
        padding: 32, fontFamily: 'Nunito, Inter, sans-serif',
      }}>
        <div style={{
          maxWidth: 520, width: '100%',
          padding: 22, textAlign: 'center',
          background: 'linear-gradient(160deg, rgba(251,73,52,0.08), rgba(47,41,39,0.8))',
          border: '1px solid rgba(251,73,52,0.25)',
          borderRadius: '18px 22px 16px 24px / 20px 16px 22px 18px',
          boxShadow: '0 16px 40px -16px rgba(0,0,0,0.5)',
        }}>
          <AlertCircle size={40} color="#fb4934" style={{ marginBottom: 10 }} />
          <h2 style={{
            fontFamily: 'Fraunces, Georgia, serif', fontSize: '1.35rem', fontWeight: 700,
            color: '#f5e6c5', margin: '0 0 6px',
          }}>
            This tab hit a snag.
          </h2>
          <p style={{ color: '#a89984', fontSize: '0.82rem', margin: '0 0 12px', lineHeight: 1.5 }}>
            Don't worry — the rest of the app still works. You can switch tabs, or try again below.
          </p>
          <pre style={{
            textAlign: 'left', fontSize: '0.7rem', color: '#fb4934',
            background: 'rgba(0,0,0,0.3)', padding: '8px 10px', borderRadius: 8,
            maxHeight: 140, overflow: 'auto', margin: '0 0 14px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}>{msg}</pre>
          <button
            onClick={this.reset}
            className="btn-primary"
            style={{
              padding: '8px 18px', fontSize: '0.78rem', fontWeight: 800,
              background: 'rgba(243,165,182,0.18)', color: '#fff9ef',
              border: '1px solid rgba(243,165,182,0.4)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      </div>
    );
  }
}
