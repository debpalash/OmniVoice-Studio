import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// When LAN sharing is on, a non-loopback request that lacks the PIN gets a 401
// from the backend middleware. `client.ts` dispatches `ov:pin-required` on that
// 401; this gate listens for it and swaps the app tree for a PIN entry form.
// `forceGate` is test-only. Submitting stores the PIN in sessionStorage (read
// by apiFetch on every subsequent request) and reloads so the gated requests
// retry with the header attached.
export default function RemoteAuthGate({ children, forceGate = false }) {
  const { t } = useTranslation();
  const [gated, setGated] = useState(forceGate);
  const [pin, setPin] = useState('');

  useEffect(() => {
    const onRequired = () => setGated(true);
    window.addEventListener('ov:pin-required', onRequired);
    return () => window.removeEventListener('ov:pin-required', onRequired);
  }, []);

  if (!gated) return children;

  const submit = (e) => {
    e.preventDefault();
    const v = pin.trim();
    if (!v) return;
    sessionStorage.setItem('ov_pin', v);
    window.location.reload();
  };

  return (
    <div className="remote-auth-gate" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="remote-auth-gate__card">
        <h2>{t('remote_gate.title')}</h2>
        <p>{t('remote_gate.body')}</p>
        <label htmlFor="ov-pin">{t('remote_gate.label')}</label>
        <input id="ov-pin" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
        <button type="submit">{t('remote_gate.connect')}</button>
      </form>
    </div>
  );
}
