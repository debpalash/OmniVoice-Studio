import React from 'react';
import { Boxes } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { Button } from '../../ui';
import { SETTINGS_SECTION_SURFACE } from './primitives';

/**
 * CataloguePointer — the Settings-side signpost for what moved to the Model
 * Catalogue workspace.
 *
 * Engine selection and the model store are now a top-level workspace
 * (`pages/ModelCatalogue.jsx`), not Settings categories. The categories stay in
 * the Settings IA on purpose: "Engines" / "Models" is where users (and every
 * doc written before the move) look first, and search still has to find them.
 * They render this instead of the panels, so the trip is one click, not a hunt.
 *
 * @param {'engines'|'models'} area  which pane to open
 */
export default function CataloguePointer({ area = 'engines' }) {
  const { t } = useTranslation();
  const openCatalogue = useAppStore((s) => s.openCatalogue);

  return (
    <section
      className={`${SETTINGS_SECTION_SURFACE} flex flex-wrap items-center gap-[var(--space-4)]`}
      data-slot="settings-section"
      data-testid={`catalogue-pointer-${area}`}
    >
      <span
        className="inline-flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[var(--chrome-radius-pill)] bg-[color-mix(in_srgb,var(--chrome-accent)_12%,var(--chrome-bg))] text-[color:var(--chrome-accent)]"
        aria-hidden="true"
      >
        <Boxes size={18} />
      </span>
      <div className="min-w-0 flex-auto">
        <h3 className="m-0 [font-family:var(--font-sans)] text-[length:var(--text-md)] font-semibold text-[color:var(--chrome-fg)]">
          {t('catalogue.moved_title')}
        </h3>
        <p className="m-0 mt-[2px] [font-family:var(--font-sans)] text-[length:var(--text-sm)] text-[color:var(--chrome-fg-muted)]">
          {t(area === 'models' ? 'catalogue.moved_models_body' : 'catalogue.moved_engines_body')}
        </p>
      </div>
      <Button variant="primary" onClick={() => openCatalogue(area)}>
        {t(area === 'models' ? 'catalogue.open_models' : 'catalogue.open_engines')}
      </Button>
    </section>
  );
}
