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

export function toastErrorWithReport(message, error) {
  const err = error instanceof Error ? error : new Error(String(error ?? message));
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
