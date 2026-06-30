import React from 'react';
import { AlertCircle, BookOpen, Bug, RefreshCw, Search } from 'lucide-react';
import i18next from 'i18next';
import { classifyError, openDocsFor } from '../utils/errorDocsMap';
import { openExternal } from '../api/external';
import { buildBugReportUrl, buildIssueSearchUrl } from '../utils/bugReport';
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

  report = async () => {
    // Prefilled GitHub Issues URL with the scrubbed error attached — the
    // user reviews everything on github.com before anything is submitted.
    try {
      await openExternal(await buildBugReportUrl({ error: this.state.error }));
    } catch (err) {
      console.warn('[ErrorBoundary] report failed', err);
    }
  };

  searchIssues = async () => {
    // "Has someone already hit this?" — issue search in the browser, so a
    // duplicate gets a 👍 on the existing thread instead of a new report.
    try {
      await openExternal(buildIssueSearchUrl(this.state.error));
    } catch (err) {
      console.warn('[ErrorBoundary] issue search failed', err);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error);
    return (
      <div className="errbnd-wrap">
        <div className="errbnd-card">
          <AlertCircle size={32} color="var(--chrome-severity-err)" className="errbnd-icon" />
          <h2 className="errbnd-title">{i18next.t('errors.title')}</h2>
          <p className="errbnd-desc">{i18next.t('errors.desc')}</p>
          <pre className="errbnd-trace">{msg}</pre>
          <div className="errbnd-actions">
            <button onClick={this.reset} className="btn-primary errbnd-retry">
              <RefreshCw size={12} /> {i18next.t('errors.tryAgain')}
            </button>
            <button
              type="button"
              onClick={this.openDocs}
              className="btn-secondary errbnd-docs"
              title={i18next.t('errors.openDocs')}
            >
              <BookOpen size={12} /> {i18next.t('errors.openDocs')}
            </button>
            <button
              type="button"
              onClick={this.searchIssues}
              className="btn-secondary errbnd-search"
              title={i18next.t('errors.searchIssues')}
            >
              <Search size={12} /> {i18next.t('errors.searchIssues')}
            </button>
            <button
              type="button"
              onClick={this.report}
              className="btn-secondary errbnd-report"
              title={i18next.t('reportBug.title')}
            >
              <Bug size={12} /> {i18next.t('errors.report')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
