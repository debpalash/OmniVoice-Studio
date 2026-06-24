import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openExternal } from '../api/external';

/**
 * HfTokenCard — the optional "add a free Hugging Face token for faster
 * downloads" card. Lifted out of the model library so the wizard can pin it
 * right next to the Continue / "Waiting for required models…" button (always
 * visible, no scrolling through the model list to find it). A free token gives
 * authenticated downloads — faster, higher rate limits, fewer stalls — and
 * unlocks gated models (pyannote speaker diarization). Persisted via the same
 * `set-env` endpoint Settings uses, so it survives restarts.
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

  return (
    <div className={`swiz-lib__hfcard ${hfState === 'saved' ? 'is-saved' : ''} ${className}`.trim()}>
      <div className="swiz-lib__hfcard-main">
        <span className="swiz-lib__hfcard-icon" aria-hidden="true">⚡</span>
        <div className="swiz-lib__hfcard-text">
          <div className="swiz-lib__hfcard-title">
            {hfState === 'saved'
              ? `✓ ${t('firstrun.hf_token_saved_fast', 'Hugging Face token saved — downloads are now faster')}`
              : t('firstrun.hf_token_card_title', 'Add a free Hugging Face token for faster downloads')}
          </div>
          <p className="swiz-lib__hfcard-hint">
            {t('firstrun.hf_token_hint', 'A free account token gives authenticated downloads (faster, higher rate limits, fewer stalls) and unlocks gated models like speaker diarization for multi-speaker dubbing (pyannote). Stays on this machine.')}
          </p>
        </div>
      </div>
      {hfState !== 'saved' && (
        <>
          <div className="swiz-lib__hf-row">
            <input
              className="frs-input"
              type="password"
              placeholder="hf_…"
              value={hfToken}
              autoComplete="off"
              onChange={(e) => { setHfToken(e.target.value); if (hfState !== 'idle') setHfState('idle'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveHfToken(); }}
              aria-label={t('firstrun.hf_token_card_title', 'Add a free Hugging Face token for faster downloads')}
            />
            <button
              type="button"
              className="frs-btn frs-btn--primary swiz-lib__hfcard-save"
              disabled={!hfToken.trim() || hfState === 'saving'}
              onClick={saveHfToken}
            >
              {hfState === 'saving'
                ? t('firstrun.hf_token_saving', 'saving…')
                : t('firstrun.hf_token_save', 'Save')}
            </button>
          </div>
          <button
            type="button"
            className="swiz-lib__hfcard-link"
            onClick={() => openExternal('https://huggingface.co/settings/tokens')}
          >
            {t('firstrun.hf_token_get', "Don't have a token? Get one free →")}
          </button>
        </>
      )}
      {hfState === 'error' && (
        <p className="frs__blocker">{t('firstrun.hf_token_error', 'Could not save the token — try again or set it later in Settings → Credentials.')}</p>
      )}
    </div>
  );
}
