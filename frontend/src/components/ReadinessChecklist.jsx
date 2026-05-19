import React from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, AlertTriangle, XCircle, Loader } from 'lucide-react';
import { usePreflight, useModelStatus } from '../api/hooks';
import './ReadinessChecklist.css';

/**
 * ReadinessChecklist — system readiness panel.
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
  const { t } = useTranslation();
  const { data: preflight, isLoading: preflightLoading } = usePreflight();
  const { data: modelData, isLoading: modelLoading } = useModelStatus();

  const isLoading = preflightLoading || modelLoading;
  const modelStatus = modelData?.status ?? 'idle';

  // Build the checklist from preflight data + model status
  const checks = [];

  // Model readiness (from /model/status)
  const modelDetail = modelData?.detail || '';
  const modelErr    = modelData?.error || null;
  const modelCheck = {
    id: 'asr-model',
    label: t('components.asr_model'),
    status: modelStatus === 'ready' ? 'pass'
      : modelStatus === 'loading' ? 'loading'
      : modelStatus === 'error' || modelData?.sub_stage === 'error' ? 'fail'
      : 'warn',
    detail: modelStatus === 'ready' ? t('components.loaded_and_ready')
      : modelStatus === 'loading' ? (modelDetail || t('components.asr_loading'))
      : (modelData?.sub_stage === 'error' ? (modelErr || t('components.asr_failed')) : t('components.asr_not_loaded')),
    fix: (modelStatus === 'error' || modelData?.sub_stage === 'error')
      ? (modelErr ? t('components.asr_fix_hint', { msg: modelErr }) : t('components.asr_fix_generic'))
      : null,
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
    label: t('components.llm_cinematic'),
    status: 'warn',
    detail: t('components.llm_configure'),
    fix: t('components.llm_fix'),
  };
  // If we have preflight and there's a network check passing, LLM is at least possible
  if (preflight?.checks) {
    const netCheck = preflight.checks.find(c => c.id === 'network');
    if (netCheck?.status === 'pass') {
      llmCheck.detail = t('components.llm_optional');
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
          {t('settings.checking_system')}
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
          {t('settings.all_systems_ready')}
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
        {t('components.system_readiness')}
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
