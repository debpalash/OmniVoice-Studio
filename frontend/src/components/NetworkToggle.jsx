// frontend/src/components/NetworkToggle.jsx
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../utils/copyText';
import QRCode from 'qrcode';
import { Wifi, WifiOff, Copy, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiJson, apiPost } from '../api/client';
import { openExternal } from '../api/external';
import './NetworkToggle.css';

export default function NetworkToggle() {
  const { t } = useTranslation();
  const [st, setSt] = useState({ enabled: false });
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [qrs, setQrs] = useState({});

  const refresh = useCallback(async () => {
    try {
      setSt(await apiJson('/system/network/state'));
    } catch {
      /* loopback only; ignore */
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!st.enabled || !st.pin) {
      setQrs({});
      return;
    }
    let cancelled = false;
    (async () => {
      const next = {};
      for (const ip of st.lan_addresses || []) {
        next[ip] = await QRCode.toDataURL(`http://${ip}:${st.share_port}/?pin=${st.pin}`);
      }
      if (!cancelled) setQrs(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [st.enabled, st.pin, st.share_port, st.lan_addresses]);

  // NOTE: do NOT use window.confirm here — it's a no-op in the Tauri webview
  // (returns false), which silently swallowed the enable action.
  const enable = async () => {
    setBusy(true);
    try {
      setSt(await apiPost('/system/network/enable'));
      setConfirming(false);
      setOpen(true);
    } catch (e) {
      toast.error(t('network.enable_error', { message: e.message }));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    setBusy(true);
    try {
      await apiPost('/system/network/disable');
      await refresh();
      setOpen(false);
    } catch (e) {
      toast.error(t('network.disable_error', { message: e.message }));
    } finally {
      setBusy(false);
    }
  };

  const copy = (text) => {
    copyText(text);
    toast.success(t('network.copied'));
  };

  return (
    <div className="net-toggle">
      <button
        className={`net-toggle__pill ${st.enabled ? 'net-toggle__pill--on' : ''}`}
        onClick={st.enabled ? () => setOpen((o) => !o) : () => setConfirming((c) => !c)}
        disabled={busy}
        title={st.enabled ? t('network.sharing_on_title') : t('network.share_on_network')}
      >
        {st.enabled ? <Wifi size={12} /> : <WifiOff size={12} />}
        <span>
          {busy ? t('network.switching') : st.enabled ? t('network.network') : t('network.local')}
        </span>
      </button>

      {!st.enabled && confirming && (
        <div className="net-toggle__panel net-toggle__panel--confirm">
          <div className="net-toggle__panel-title">{t('network.share_confirm_title')}</div>
          <p className="net-toggle__hint">{t('network.share_confirm_hint')}</p>
          <div className="net-toggle__confirm-actions">
            <button
              type="button"
              className="net-toggle__cancel"
              onClick={() => setConfirming(false)}
              disabled={busy}
            >
              {t('common.cancel')}
            </button>
            <button type="button" className="net-toggle__enable" onClick={enable} disabled={busy}>
              {busy ? t('network.enabling') : t('network.enable')}
            </button>
          </div>
        </div>
      )}

      {st.enabled && open && (
        <div className="net-toggle__panel">
          <div className="net-toggle__panel-title">{t('network.shared_title')}</div>
          {(st.lan_addresses || []).length === 0 && (
            <p className="net-toggle__hint">{t('network.no_interface')}</p>
          )}
          {(st.lan_addresses || []).map((ip) => {
            const url = `http://${ip}:${st.share_port}/?pin=${st.pin}`;
            return (
              <div key={ip} className="net-toggle__row">
                <div className="net-toggle__row-main">
                  <code className="net-toggle__addr">
                    {ip}:{st.share_port}
                  </code>
                  <div className="net-toggle__row-actions">
                    <button
                      type="button"
                      className="net-toggle__iconbtn"
                      onClick={() => copy(url)}
                      aria-label={`Copy ${ip}`}
                      title={t('network.copy_link')}
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      type="button"
                      className="net-toggle__iconbtn"
                      onClick={() => openExternal(url)}
                      aria-label={`Open ${ip}`}
                      title={t('network.open_in_browser')}
                    >
                      <ExternalLink size={12} />
                    </button>
                  </div>
                </div>
                {qrs[ip] && (
                  <img
                    className="net-toggle__qr"
                    src={qrs[ip]}
                    alt={t('network.qr_alt', { ip })}
                    width={104}
                    height={104}
                  />
                )}
              </div>
            );
          })}
          <div className="net-toggle__pin">
            {t('network.pin')} <strong>{st.pin}</strong>
          </div>
          <button type="button" className="net-toggle__off" onClick={disable} disabled={busy}>
            {t('network.stop_sharing')}
          </button>
        </div>
      )}
    </div>
  );
}
