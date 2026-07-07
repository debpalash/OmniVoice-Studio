import React, { useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { addBreadcrumb } from '../../utils/breadcrumbs';
import { selectEngine } from '../../api/engines';
import { notifyEngineSelected } from '../../utils/engineSelectToast';
import EngineCompatibilityMatrix from '../EngineCompatibilityMatrix';
import { SETTINGS_SECTION_SURFACE } from './primitives';

export default function EnginesTab() {
  const { t } = useTranslation();

  // Plan 02-04 / ENGINE-06 — engine selection is wired through the
  // matrix component's optional onSelect callback so the matrix doubles
  // as a picker. Keeps a single source of truth for the engine list +
  // its install / GPU / isolation state.
  //
  // Review mode (the staged-checkpoint nudges) moved to Settings → General.
  const onSelect = useCallback(
    // modelId is only ever set by mlx-audio's curated-model picker (#981) —
    // every other call site (the "Use" button) omits it.
    async (family, backendId, modelId) => {
      try {
        addBreadcrumb(`engine:${family}=${backendId}`);
        const r = await selectEngine(family, backendId, modelId);
        // Consume the routing echo: warn (not a bare success) when the pick
        // lands on a CPU fallback on this host. See notifyEngineSelected.
        notifyEngineSelected(r, t, family);
      } catch (e) {
        toast.error(e.message || t('engines.switch_failed'));
      }
    },
    [t],
  );

  return (
    <section className={SETTINGS_SECTION_SURFACE} data-slot="settings-section">
      <EngineCompatibilityMatrix family="tts" onSelect={onSelect} />
    </section>
  );
}
