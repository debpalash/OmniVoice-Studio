import React, { useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { addBreadcrumb } from '../../utils/breadcrumbs';
import { selectEngine } from '../../api/engines';
import { Segmented } from '../../ui';
import { useAppStore } from '../../store';
import EngineCompatibilityMatrix from '../EngineCompatibilityMatrix';
import { SETTINGS_SECTION_SURFACE } from './primitives';

export default function EnginesTab() {
  const { t } = useTranslation();
  const reviewMode = useAppStore((s) => s.reviewMode);
  const setReviewMode = useAppStore((s) => s.setReviewMode);

  // Plan 02-04 / ENGINE-06 — engine selection is wired through the
  // matrix component's optional onSelect callback so the matrix doubles
  // as a picker. Keeps a single source of truth for the engine list +
  // its install / GPU / isolation state.
  const onSelect = useCallback(async (family, backendId) => {
    try {
      addBreadcrumb(`engine:${family}=${backendId}`);
      const r = await selectEngine(family, backendId);
      toast.success(
        t('settings.engine_switched', { family: family.toUpperCase(), engine: r.active }),
      );
    } catch (e) {
      toast.error(e.message || t('engines.switch_failed'));
    }
  }, []);

  return (
    <section className={SETTINGS_SECTION_SURFACE} data-slot="settings-section">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] px-[2px] pb-[6px] pt-[2px] font-[family-name:var(--chrome-font-mono)] text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] max-[580px]:flex-col max-[580px]:items-start">
        <div className="inline-flex flex-wrap items-center gap-[var(--space-2)]">
          <Segmented
            size="xs"
            value={reviewMode}
            onChange={setReviewMode}
            items={[
              { value: 'on', label: t('engines.review_on') },
              { value: 'off', label: t('engines.review_off') },
            ]}
          />
          <span className="text-[var(--chrome-fg-dim)]">·</span>
          <span>{reviewMode === 'on' ? t('engines.banners_on') : t('engines.banners_off')}</span>
        </div>
      </div>

      <EngineCompatibilityMatrix family="tts" onSelect={onSelect} />
    </section>
  );
}
