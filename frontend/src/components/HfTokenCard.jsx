import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { openExternal } from '../api/external';
import { apiJson } from '../api/client';
import { Button, Input } from '../ui';

/**
 * HfTokenCard — a compact, single-line Hugging Face token input that lives in
 * the wizard's pinned action area, right by the "Waiting for required models…"
 * / Continue button. A free token gives authenticated downloads (faster,
 * higher rate limits, fewer stalls) and unlocks gated models (pyannote
 * diarization). Persisted via the same `set-env` endpoint Settings uses, so
 * it survives restarts.
 *
 * Before pitching a token, it checks the resolver state (same endpoint the
 * Settings → API Keys panel uses, `ApiKeysPanel.jsx`) so a user who already
 * has a validated token — from the app store, an env var, or `huggingface-cli
 * login` — sees that instead of a blind "add a token" prompt (#FR-006).
 * Replacing an already-active token is gated behind an explicit "Replace…"
 * click rather than being one blind paste-and-Save away, since Save persists
 * via `huggingface_hub.login()`, which overwrites `$HF_HOME/token` outright.
 *
 * @param {string=} className extra class on the root (e.g. layout pinning).
 */
export default function HfTokenCard({ className = '' }) {
  const { t } = useTranslation();
  const [hfToken, setHfToken] = useState('');
  const [hfState, setHfState] = useState('idle'); // idle | saving | saved | error

  // Resolver state (mirrors ApiKeysPanel's `state`/`refresh` pair): null while
  // the first GET is in flight, 'error' when it fails — either way we never
  // want to flash a false "you have no token" pitch before we actually know.
  const [tokenState, setTokenState] = useState(null);
  const [checkFailed, setCheckFailed] = useState(false);
  // Explicit gate: revealing the paste-a-token form when a token is already
  // active requires this deliberate click, so Save can never blind-clobber a
  // working token.
  const [replacing, setReplacing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiJson('/system/hf-token/state');
        if (!cancelled) setTokenState(data);
      } catch {
        if (!cancelled) setCheckFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Still checking — never flash the "add a token" pitch before we know
  // whether one is already active.
  if (tokenState == null && !checkFailed) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border border-transparent bg-primary/[0.07] px-3 py-2 text-sm text-fg-muted',
          className,
        )}
      >
        <Zap size={16} className="shrink-0 text-primary" aria-hidden="true" />
        {t('firstrun.checking', 'checking…')}
      </div>
    );
  }

  const SOURCE_LABELS = {
    app: t('settings.hf_source_app_label', {
      defaultValue: 'VoiceStudio (encrypted, recommended)',
    }),
    env: t('settings.hf_source_env_label', { defaultValue: 'Environment variable' }),
    'hf-cli': t('settings.hf_source_cli_label', { defaultValue: 'HuggingFace CLI' }),
  };
  const activeRow =
    tokenState && tokenState.active
      ? tokenState.sources?.find((r) => r.source === tokenState.active)
      : null;

  // A validated token is already active and the user hasn't asked to replace
  // it — show the satisfied state, not the pitch (#FR-006).
  if (activeRow && !replacing) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-md border border-transparent bg-success/[0.09] px-3 py-2 text-sm',
          className,
        )}
      >
        <Check size={16} className="shrink-0 text-success" aria-hidden="true" />
        <span className="font-semibold text-success">
          {t('firstrun.hf_token_active_using', {
            source: SOURCE_LABELS[tokenState.active] || tokenState.active,
            masked: activeRow.masked || '',
            defaultValue: 'Using your Hugging Face token from {{source}} — {{masked}}',
          })}
        </span>
        <button
          type="button"
          className="cursor-pointer appearance-none whitespace-nowrap border-0 bg-transparent p-0 text-[0.76rem] text-primary underline hover:no-underline"
          onClick={() => setReplacing(true)}
        >
          {t('firstrun.hf_token_replace', 'Replace token…')}
        </button>
      </div>
    );
  }

  // No active token (or the state check failed — fail toward the pre-fix
  // behavior rather than hiding the card), or the user explicitly chose to
  // replace an active one.
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border border-transparent bg-primary/[0.07] px-3 py-2 text-sm',
        className,
      )}
    >
      <Zap size={16} className="shrink-0 text-primary" aria-hidden="true" />
      <span
        className={cn('font-semibold', !(replacing && activeRow) && 'max-[560px]:hidden')}
      >
        {replacing && activeRow
          ? t(
              'firstrun.hf_token_replace_warning',
              'This replaces the token above — the old one stops working.',
            )
          : t('firstrun.hf_token_inline_prompt', 'Speed up downloads with a free Hugging Face token')}
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
      {replacing && activeRow && (
        <button
          type="button"
          className="cursor-pointer appearance-none whitespace-nowrap border-0 bg-transparent p-0 text-[0.76rem] text-fg-muted underline hover:no-underline"
          onClick={() => {
            setReplacing(false);
            setHfToken('');
            setHfState('idle');
          }}
        >
          {t('common.cancel', 'Cancel')}
        </button>
      )}
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
