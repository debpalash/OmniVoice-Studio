/**
 * Settings → Privacy → "Invisible watermark" — the control the app already
 * promised.
 *
 * `errors.a_watermark` told users "Commercial licensees can disable it in
 * Settings → Privacy". That control did not exist: the backend endpoints
 * (`/watermark/status`, `/watermark/settings`) had zero callers in the
 * frontend, `is_enabled()` passes no `env=` to `resolve()` so there was no
 * environment escape either, and the only way off was hand-editing prefs.json.
 * A shipped instruction that cannot be followed is worse than no instruction.
 *
 * Deliberately mirrors AnalyticsOptIn's shape but inverts its default: analytics
 * is OFF until you opt in, provenance marking is ON until you opt out. Both are
 * honest about which way they point rather than hiding behind a policy page.
 *
 * When AudioSeal is unavailable on this install the toggle is not offered — an
 * inert switch claiming to control a mark that cannot be embedded would be the
 * same lie in the other direction.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { getWatermarkStatus, setWatermarkSettings } from '../../api/watermark';
import { SettingRow, SettingsToggle } from './primitives';

export default function WatermarkControl() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWatermarkStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // Backend down or endpoint missing — render nothing rather than an
        // inert control.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.audioseal_available) return null;

  const toggle = async () => {
    const next = !status.invisible_enabled;
    setBusy(true);
    try {
      const updated = await setWatermarkSettings({ invisible_enabled: next });
      setStatus((prev) => ({ ...prev, ...updated }));
      toast.success(
        next
          ? t('privacy.watermark_on_toast', {
              defaultValue: 'Invisible watermark enabled for new audio.',
            })
          : t('privacy.watermark_off_toast', {
              defaultValue: 'Invisible watermark disabled for new audio.',
            }),
      );
    } catch {
      toast.error(
        t('privacy.watermark_failed', {
          defaultValue: 'Could not change the watermark setting.',
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      title={t('privacy.watermark_title', { defaultValue: 'Invisible watermark' })}
      subtitle={t('privacy.watermark_subtitle', {
        defaultValue:
          'On by default. Marks generated audio as AI-made so it can be identified later. Only affects audio generated from now on.',
      })}
      control={
        <SettingsToggle
          checked={!!status.invisible_enabled}
          disabled={busy}
          onChange={toggle}
          aria-label={t('privacy.watermark_title', { defaultValue: 'Invisible watermark' })}
          data-testid="watermark-toggle"
        />
      }
    />
  );
}
