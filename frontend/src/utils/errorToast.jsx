/**
 * errorToast — error toast with a "Report" action.
 *
 * Drop-in upgrade for `toast.error(message)` at call sites that have the
 * failure in hand: same toast, plus a button that opens the prefilled
 * GitHub Issues form (utils/bugReport.js) with the scrubbed error attached.
 * Nothing is sent anywhere until the user clicks Submit on github.com.
 */
import toast from 'react-hot-toast';
import i18next from 'i18next';
import { openExternal } from '../api/external';
import { buildBugReportUrl } from './bugReport';

// #1188: backend errors that carry a machine-readable "[code]" marker are
// user-fixable input problems, not bugs — show localized guidance (what
// happened + the concrete fix) instead of the raw English detail, and skip
// the "Report" action. Markers are emitted by the backend (the
// [clone_ref_unusable] one in omnivoice/utils/audio.py) — keep in sync.
const USER_FIXABLE_MARKERS = {
  '[clone_ref_unusable]': 'tts_errors.ref_audio_unusable',
};

// #1276: 503 means "not now, try again" — a shutting-down or still-warming
// backend, by definition not a fault. Offering to file a GitHub issue for one
// invites bug reports for normal lifecycle events (quitting the app with a
// generate queued reported "500 … model load skipped: backend shutting down"
// before the backend started answering 503 here). Show the message; the
// backend's detail already says what to do.
const TRANSIENT_STATUSES = new Set([503]);

export function toastErrorWithReport(message, error) {
  const err = error instanceof Error ? error : new Error(String(error ?? message));
  const raw = `${err.message ?? ''} ${message ?? ''}`;
  for (const [marker, i18nKey] of Object.entries(USER_FIXABLE_MARKERS)) {
    if (raw.includes(marker)) {
      toast.error(i18next.t(i18nKey), { duration: 8000 });
      return;
    }
  }
  if (TRANSIENT_STATUSES.has(error?.status)) {
    toast.error(message, { duration: 8000 });
    return;
  }
  toast.error(
    (tst) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ flex: 1 }}>{message}</span>
        <button
          type="button"
          className="btn-secondary"
          style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          onClick={async () => {
            toast.dismiss(tst.id);
            try {
              await openExternal(await buildBugReportUrl({ error: err }));
            } catch (e) {
              // openExternal already falls back to window.open; if even
              // that failed there's nothing actionable left to surface.
              console.warn('[errorToast] report action failed', e);
            }
          }}
        >
          {i18next.t('errors.report')}
        </button>
      </div>
    ),
    { duration: 8000 },
  );
}
