import React from 'react';
import { withTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw } from 'lucide-react';
import './WaveformErrorBoundary.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`[ErrorBoundary:${this.props.name || 'anon'}]`, error, info?.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;

    const { t } = this.props;
    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div className="errbnd-wrap">
        <div className="errbnd-card">
          <AlertCircle size={32} color="var(--chrome-severity-err)" className="errbnd-icon" />
          <h2 className="errbnd-title">
            {t('components.this_tab_snag')}
          </h2>
          <p className="errbnd-desc">
            {t('components.snag_desc')}
          </p>
          <pre className="errbnd-trace">{msg}</pre>
          <button
            onClick={this.reset}
            className="btn-primary errbnd-retry"
          >
            <RefreshCw size={12} /> {t('components.try_again')}
          </button>
        </div>
      </div>
    );
  }
}

export default withTranslation()(ErrorBoundary);
