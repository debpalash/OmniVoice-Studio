import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../api/external';

/**
 * HfTokenCard — a compact, single-line Hugging Face token input that lives in
 * the wizard's pinned action area, right by the "Waiting for required models…"
 * / Continue button. It takes only the HF token: paste it, Save, done. A free
 * token gives authenticated downloads (faster, higher rate limits, fewer
 * stalls) and unlocks gated models (pyannote diarization). Persisted via the
 * same `set-env` endpoint Settings uses, so it survives restarts.
 *
 * @param {string=} className extra class on the root (e.g. layout pinning).
 */
export default function HfTokenCard({ className = '' }) {
  const { t } = useTranslation();
  const [hfToken, setHfToken] = useState('');
  const [hfState, setHfState] = useState('idle'); // idle | saving | saved | error

  const saveHfToken = async () => {
    const value = hfToken.trim();
    if (!value || hfState === 'saving') return;
    setHfState('saving');
    try {
      const { API } = await import('../api/client');
      const res = await fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'HF_TOKEN', value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setHfState('saved');
      setHfToken('');
    } catch {
      setHfState('error');
    }
  };

  if (hfState === 'saved') {
    return (
      <div className={`swiz-hfbar is-saved ${className}`.trim()}>
        <span className="swiz-hfbar__done">
          <span aria-hidden="true">✓</span>{' '}
          {t('firstrun.hf_token_saved_fast', 'Hugging Face token saved — downloads are now faster')}
        </span>
      </div>
    );
  }

  return (
    <div className={`swiz-hfbar ${className}`.trim()}>
      <span className="swiz-hfbar__icon" aria-hidden="true">⚡</span>
      <span className="swiz-hfbar__prompt">
        {t('firstrun.hf_token_inline_prompt', 'Speed up downloads with a free Hugging Face token')}
      </span>
      <input
        className="frs-input swiz-hfbar__input"
        type="password"
        placeholder={t('firstrun.hf_token_inline_ph', 'Paste hf_… token (optional)')}
        value={hfToken}
        autoComplete="off"
        onChange={(e) => { setHfToken(e.target.value); if (hfState !== 'idle') setHfState('idle'); }}
        onKeyDown={(e) => { if (e.key === 'Enter') saveHfToken(); }}
        aria-label={t('firstrun.hf_token_card_title', 'Add a free Hugging Face token for faster downloads')}
      />
      <button
        type="button"
        className="frs-btn frs-btn--primary swiz-hfbar__save"
        disabled={!hfToken.trim() || hfState === 'saving'}
        onClick={saveHfToken}
      >
        {hfState === 'saving'
          ? t('firstrun.hf_token_saving', 'saving…')
          : t('firstrun.hf_token_save', 'Save')}
      </button>
      <button
        type="button"
        className="swiz-hfbar__link"
        onClick={() => openExternal('https://huggingface.co/settings/tokens')}
      >
        {t('firstrun.hf_token_get_short', 'Get one free →')}
      </button>
      {hfState === 'error' && (
        <span className="swiz-hfbar__err">
          {t('firstrun.hf_token_error', 'Could not save the token — try again or set it later in Settings → Credentials.')}
        </span>
      )}
    </div>
  );
}
