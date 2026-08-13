import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Cpu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listLoadedModels } from '../api/system';
import { useEngines, useSelectEngine } from '../api/hooks';
import { notifyEngineSelected } from '../utils/engineSelectToast';
import { useAppStore } from '../store';
import { MENU_SURFACE } from './computeTarget';

/**
 * A compact TTS/ASR/LLM picker for chrome that needs to expose the active
 * engine without growing a second engine-management surface. The matrix stays
 * the detailed view; this lists only engines that are ready to be used.
 */
export default function EngineQuickSwitch({
  family = 'tts',
  className = '',
  shortcutTarget = false,
  // The footer chip opens upward (nothing below the last row on screen);
  // workspace-header chips must open downward or the popover clips off the
  // top of the viewport.
  dropUp = false,
}) {
  const { t } = useTranslation();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [switchError, setSwitchError] = useState('');
  const { data: engines } = useEngines();
  const selectMutation = useSelectEngine();
  const { data: residency } = useQuery({
    queryKey: ['loaded-models'],
    queryFn: listLoadedModels,
    staleTime: 10_000,
    retry: false,
    enabled: open,
  });

  const familyData = engines?.[family];
  const active = familyData?.backends?.find((engine) => engine.id === familyData.active);
  const available = useMemo(
    () => (familyData?.backends || []).filter((engine) => engine.available),
    [familyData],
  );
  const residentIds = useMemo(
    () =>
      new Set(
        (residency?.models || []).flatMap((model) => (model.engine_id ? [model.engine_id] : [])),
      ),
    [residency],
  );

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // In-webview shortcut bridge. This stays a DOM event (not a Tauri global
  // shortcut), so every desktop and browser build behaves the same way.
  useEffect(() => {
    if (!shortcutTarget) return undefined;
    const show = () => {
      setSwitchError('');
      setOpen(true);
    };
    window.addEventListener('engine-quick-switch', show);
    return () => window.removeEventListener('engine-quick-switch', show);
  }, [shortcutTarget]);

  if (!active || available.length === 0) return null;

  const locked = Boolean(familyData.env_override);
  const choose = async (backendId) => {
    if (backendId === familyData.active || locked) return;
    setSwitchError('');
    try {
      const result = await selectMutation.mutateAsync({ family, backendId });
      if (result.env_override) {
        setSwitchError(t('settings.llmp_env_override'));
        return;
      }
      notifyEngineSelected(result, t, family);
      setOpen(false);
    } catch (error) {
      setSwitchError(error?.message || t('engines.switch_failed'));
    }
  };

  return (
    <div className={`relative inline-flex shrink-0 items-center ${className}`} ref={rootRef}>
      <button
        type="button"
        onClick={() => {
          setSwitchError('');
          setOpen((value) => !value);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('engines.activeEngine', {
          family: family.toUpperCase(),
          engine: active.display_name,
        })}
        aria-label={t('engines.activeEngine', {
          family: family.toUpperCase(),
          engine: active.display_name,
        })}
        className="inline-flex h-[20px] items-center gap-[5px] rounded-sm border-0 bg-transparent px-[7px] text-[11px] font-medium text-[color:var(--chrome-fg-muted)] transition-[background,color] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)]"
      >
        <Cpu size={13} aria-hidden="true" />
        <span className="max-w-[124px] truncate">{active.display_name}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('engines.engineCompatLabel', { family: family.toUpperCase() })}
          className={`absolute right-0 z-[60] flex w-[272px] flex-col gap-[4px] p-[8px] ${
            dropUp ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]'
          } ${MENU_SURFACE}`}
        >
          {locked && (
            <p className="m-[4px] text-[11px] leading-[1.4] text-[color:var(--chrome-fg-muted)]">
              {t('settings.llmp_env_override')}
            </p>
          )}
          {available.map((engine) => {
            const isActive = engine.id === familyData.active;
            const warm = residentIds.has(engine.id);
            return (
              <button
                key={engine.id}
                type="button"
                disabled={isActive || locked || selectMutation.isPending}
                onClick={() => choose(engine.id)}
                className="flex w-full items-center gap-[8px] rounded-[5px] border-0 bg-transparent px-[7px] py-[6px] text-left text-[11px] text-[color:var(--chrome-fg)] hover:bg-[var(--chrome-hover-bg)] disabled:cursor-default disabled:opacity-60"
              >
                <span className="w-[12px] shrink-0">
                  {isActive && <Check size={12} aria-label={t('engines.active')} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{engine.display_name}</span>
                <span className="shrink-0 text-[10px] text-[color:var(--chrome-fg-muted)]">
                  {warm ? t('engines.inMemory') : t('engines.available')}
                </span>
              </button>
            );
          })}
          {switchError && (
            <p
              role="alert"
              className="m-[4px] text-[11px] leading-[1.4] text-[color:var(--chrome-severity-err)]"
            >
              {switchError}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              useAppStore.getState().openCatalogue({ pane: 'engines', family });
            }}
            className="mt-[3px] flex items-center gap-[3px] border-0 bg-transparent px-[7px] py-[5px] text-left text-[11px] text-[color:var(--chrome-fg-muted)] hover:text-[color:var(--chrome-fg)]"
          >
            {t('settings.engines')} <ChevronRight size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
