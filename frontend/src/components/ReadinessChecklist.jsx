import React from 'react';
import { CheckCircle, AlertTriangle, XCircle, Loader } from 'lucide-react';
import { usePreflight, useModelStatus } from '../api/hooks';
import './ReadinessChecklist.css';

/**
 * ReadinessChecklist — VoiceBox-style system readiness panel.
 *
 * Consumes the existing /setup/preflight endpoint (OS, RAM, GPU, ffmpeg,
 * yt-dlp, network) plus /model/status, and renders a compact pass/warn/fail
 * checklist. Mirrors into Settings and renders as empty-state on the
 * launchpad when no project is loaded.
 *
 * Hides itself when all gates are green (user doesn't need to see
 * "everything is fine" every time they open the app).
 */

const StatusIcon = ({ status, size = 14 }) => {
  switch (status) {
    case 'pass':    return <CheckCircle size={size} />;
    case 'warn':    return <AlertTriangle size={size} />;
    case 'fail':    return <XCircle size={size} />;
    case 'loading': return <Loader size={size} />;
    default:        return <Loader size={size} />;
  }
};

export default function ReadinessChecklist({ compact = false, showWhenAllPass = false }) {
  const { data: preflight, isLoading: preflightLoading } = usePreflight();
  const { data: modelData, isLoading: modelLoading } = useModelStatus();

  const isLoading = preflightLoading || modelLoading;
  const modelStatus = modelData?.status ?? 'idle';

  // Build the checklist from preflight data + model status
  const checks = [];

  // Model readiness (from /model/status)
  const modelCheck = {
    id: 'asr-model',
    label: 'ASR Model',
    status: modelStatus === 'ready' ? 'pass'
      : modelStatus === 'loading' ? 'loading'
      : modelStatus === 'error' ? 'fail'
      : 'warn',
    detail: modelStatus === 'ready' ? 'Loaded and ready'
      : modelStatus === 'loading' ? 'Loading… (this may take 1-2 minutes on first run)'
      : modelStatus === 'error' ? 'Failed to load'
      : 'Not loaded yet — will load on first transcription',
    fix: modelStatus === 'error' ? 'Check logs for model loading errors. Try restarting.' : null,
  };
  checks.push(modelCheck);

  // Add preflight checks
  if (preflight?.checks) {
    // Filter to the most relevant checks for the checklist
    const relevant = ['gpu', 'ffmpeg', 'yt-dlp', 'ram'];
    for (const check of preflight.checks) {
      if (relevant.includes(check.id)) {
        checks.push(check);
      }
    }
  }

  // LLM configuration (check for translate endpoint)
  const llmCheck = {
    id: 'llm',
    label: 'LLM (Cinematic)',
    status: 'warn',
    detail: 'Configure TRANSLATE_BASE_URL for Cinematic translation quality',
    fix: 'Set TRANSLATE_BASE_URL and TRANSLATE_API_KEY environment variables. Works with Ollama, OpenAI, LM Studio, etc.',
  };
  // If we have preflight and there's a network check passing, LLM is at least possible
  if (preflight?.checks) {
    const netCheck = preflight.checks.find(c => c.id === 'network');
    if (netCheck?.status === 'pass') {
      llmCheck.detail = 'Optional — set TRANSLATE_BASE_URL for Cinematic quality';
    }
  }
  checks.push(llmCheck);

  // Determine if all critical checks pass
  const allPass = checks.every(c => c.status === 'pass' || c.status === 'warn');
  const anyFail = checks.some(c => c.status === 'fail');
  const criticalFails = checks.filter(c => c.status === 'fail');

  // Hide when everything is fine (unless explicitly asked to show)
  if (!showWhenAllPass && allPass && !isLoading) return null;

  if (isLoading) {
    return (
      <div className="readiness-checklist">
        <div className="readiness-checklist__title">
          <span className="readiness-checklist__title-icon">🔍</span>
          Checking system…
        </div>
      </div>
    );
  }

  if (compact) {
    // Compact mode: just show failing/warning items
    const issues = checks.filter(c => c.status !== 'pass');
    if (issues.length === 0) {
      return (
        <div className="readiness-checklist__all-pass">
          <CheckCircle size={14} />
          All systems ready
        </div>
      );
    }
    return (
      <div className="readiness-checklist">
        <ul className="readiness-checklist__list">
          {issues.map(check => (
            <li key={check.id} className="readiness-checklist__item">
              <span className={`readiness-checklist__status readiness-checklist__status--${check.status}`}>
                <StatusIcon status={check.status} />
              </span>
              <div>
                <div className="readiness-checklist__label">{check.label}</div>
                {check.fix && <div className="readiness-checklist__fix">{check.fix}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="readiness-checklist">
      <div className="readiness-checklist__title">
        <span className="readiness-checklist__title-icon">
          {anyFail ? '⚠️' : '✅'}
        </span>
        System Readiness
      </div>
      <ul className="readiness-checklist__list">
        {checks.map(check => (
          <li key={check.id} className="readiness-checklist__item">
            <span className={`readiness-checklist__status readiness-checklist__status--${check.status}`}>
              <StatusIcon status={check.status} />
            </span>
            <div>
              <div className="readiness-checklist__label">{check.label}</div>
              <div className="readiness-checklist__detail">{check.detail}</div>
              {check.fix && <div className="readiness-checklist__fix">💡 {check.fix}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
