import React from 'react';
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '../../../ui';
import { openExternal } from '../../../api/external';

/**
 * InfoHint — a small info affordance that moves long prose OUT of the row body
 * and into an on-demand tooltip. Renders a 13px lucide `Info` glyph (dim) that
 * opens the shared Tooltip with the help content; an optional "Learn more →"
 * link opens an external URL via the app's external-open helper.
 *
 * Use this anywhere the old design had a multi-line `<p className="…__help">`.
 *
 * @param {ReactNode} children      the help prose shown inside the tooltip
 * @param {string=}   label         accessible label for the trigger (default: "More info")
 * @param {string=}   learnMoreHref optional URL; renders a "Learn more →" link in the tooltip
 */
export default function InfoHint({ children, label, learnMoreHref }) {
  const { t } = useTranslation();
  const ariaLabel = label || t('common.more_info', 'More info');

  const content = (
    <div className="st-hint__content">
      <div className="st-hint__prose">{children}</div>
      {learnMoreHref && (
        <button type="button" className="st-hint__link" onClick={() => openExternal(learnMoreHref)}>
          {t('common.learn_more', 'Learn more')} →
        </button>
      )}
    </div>
  );

  return (
    <Tooltip content={content} placement="top">
      <button
        type="button"
        className="st-hint"
        aria-label={ariaLabel}
        onClick={(e) => e.preventDefault()}
      >
        <Info size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
