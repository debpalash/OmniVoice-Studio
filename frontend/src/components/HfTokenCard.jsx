import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openExternal } from '../api/external';
import { Button, Input } from '../ui';

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
      const { apiFetch } = await import('../api/client');
      await apiFetch('/system/set-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'HF_TOKEN', value }),
      });
      setHfState('saved');
      setHfToken('');
    } catch {
      setHfState('error');
    }
  };

  if (hfState === 'saved') {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md border border-transparent bg-success/[0.09] px-3 py-2 text-sm',
          className,
        )}
      >
        <span className="inline-flex items-center gap-1.5 font-semibold text-success">
          <Check size={14} aria-hidden="true" />
          {t('firstrun.hf_token_saved_fast', 'Hugging Face token saved — downloads are now faster')}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-transparent bg-primary/[0.07] px-3 py-2 text-sm',
        className,
      )}
    >
      <Zap size={16} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="font-semibold max-[560px]:hidden">
        {t('firstrun.hf_token_inline_prompt', 'Speed up downloads with a free Hugging Face token')}
      </span>
      <Input
        size="sm"
        className="min-w-[130px] flex-1 basis-[180px]"
        type="password"
        placeholder={t('firstrun.hf_token_inline_ph', 'Paste hf_… token (optional)')}
        value={hfToken}
        autoComplete="off"
        onChange={(e) => {
          setHfToken(e.target.value);
          if (hfState !== 'idle') setHfState('idle');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveHfToken();
        }}
        aria-label={t(
          'firstrun.hf_token_card_title',
          'Add a free Hugging Face token for faster downloads',
        )}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={!hfToken.trim() || hfState === 'saving'}
        onClick={saveHfToken}
      >
        {hfState === 'saving'
          ? t('firstrun.hf_token_saving', 'saving…')
          : t('firstrun.hf_token_save', 'Save')}
      </Button>
      <button
        type="button"
        className="cursor-pointer appearance-none whitespace-nowrap border-0 bg-transparent p-0 text-[0.76rem] text-primary underline hover:no-underline"
        onClick={() => openExternal('https://huggingface.co/settings/tokens')}
      >
        {t('firstrun.hf_token_get_short', 'Get one free →')}
      </button>
      {hfState === 'error' && (
        <span className="basis-full text-[0.76rem] text-danger">
          {t(
            'firstrun.hf_token_error',
            'Could not save the token — try again or set it later in Settings → Credentials.',
          )}
        </span>
      )}
    </div>
  );
}
