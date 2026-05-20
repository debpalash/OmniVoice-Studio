import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { apiPost } from '../api/client';
import './SupertonicLicenseDialog.css';

/**
 * Supertonic-3 license acceptance modal (Phase 3 Plan 03-01 / TTS-05).
 *
 * Rendered by ``EngineCompatibilityMatrix`` when the user toggles the
 * Supertonic-3 row's Enable / Use button while the backend reports
 * ``available=false`` with ``reason`` containing
 * ``"license not accepted"``. On Accept the dialog POSTs to
 * ``/api/settings/license`` (loopback-gated, allow-list of one engine
 * id ‑‑ ``"supertonic3"``); on success it calls ``onAccepted()`` so the
 * matrix re-fetches engine status.
 *
 * Licenses surfaced:
 *   • SDK code ‑‑ MIT (https://github.com/supertone-inc/supertonic/blob/main/LICENSE)
 *   • Model weights ‑‑ OpenRAIL-M (https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE)
 *
 * Both links open in the user's default browser. The dialog does NOT
 * embed the full license text ‑‑ that's the user's call to make on
 * github.com / huggingface.co. We only need their explicit click to
 * Accept.
 *
 * Props:
 *   - open: boolean         ‑‑ controls visibility
 *   - onClose: () => void   ‑‑ user clicked Cancel / clicked outside
 *   - onAccepted: () => void‑‑ user clicked Accept and POST succeeded
 */

const LICENSE_URLS = {
  code: 'https://github.com/supertone-inc/supertonic/blob/main/LICENSE',
  model: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
};

export default function SupertonicLicenseDialog({ open, onClose, onAccepted }) {
  const [submitting, setSubmitting] = useState(false);

  // Escape closes the dialog ‑‑ mirrors browser-standard modal UX.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, submitting]);

  const accept = useCallback(async () => {
    setSubmitting(true);
    try {
      await apiPost('/api/settings/license', {
        engine_id: 'supertonic3',
        accepted: true,
      });
      toast.success('Supertonic-3 license accepted.');
      onAccepted?.();
      onClose?.();
    } catch (e) {
      const msg = e?.message || String(e);
      toast.error(`Failed to record license acceptance: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }, [onAccepted, onClose]);

  if (!open) return null;

  return (
    <div
      className="supertonic-license"
      role="dialog"
      aria-modal="true"
      aria-labelledby="supertonic-license-title"
      onClick={(e) => {
        // Click outside the card closes the dialog ‑‑ but only when the
        // click landed on the backdrop, not on a child element.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="supertonic-license__card">
        <h2 id="supertonic-license-title" className="supertonic-license__title">
          Supertonic-3 — License Acceptance
        </h2>

        <p className="supertonic-license__intro">
          Supertonic-3 ships under two distinct licenses. Please review
          both before enabling the engine.
        </p>

        <div className="supertonic-license__sections">
          <section className="supertonic-license__section">
            <h3>SDK Code · MIT</h3>
            <p>
              The Python inference SDK (
              <code>supertonic</code>
              ) is MIT-licensed. Permissive use, including commercial.
            </p>
            <a
              href={LICENSE_URLS.code}
              target="_blank"
              rel="noopener noreferrer"
              className="supertonic-license__link"
            >
              Read the MIT license →
            </a>
          </section>

          <section className="supertonic-license__section">
            <h3>Model Weights · OpenRAIL-M</h3>
            <p>
              The Supertonic-3 model weights are released under the
              OpenRAIL-M license. This license restricts use to
              non-malicious purposes ‑‑ see the linked license for the
              full set of use-based restrictions.
            </p>
            <a
              href={LICENSE_URLS.model}
              target="_blank"
              rel="noopener noreferrer"
              className="supertonic-license__link"
            >
              Read the OpenRAIL-M license →
            </a>
          </section>
        </div>

        <p className="supertonic-license__footer">
          Clicking Accept records your acceptance in OmniVoice&apos;s
          local settings and enables the engine. Your acceptance is
          stored on this machine only ‑‑ nothing is reported to
          Supertone Inc. or any third party.
        </p>

        <div className="supertonic-license__actions">
          <button
            type="button"
            className="supertonic-license__btn supertonic-license__btn--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="supertonic-license__btn supertonic-license__btn--primary"
            onClick={accept}
            disabled={submitting}
            autoFocus
          >
            {submitting ? 'Saving…' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
