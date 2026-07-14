import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveApiKey } from '../api/client';

// On a remote device the backend can demand EITHER a LAN-share PIN
// (NetworkAccessMiddleware → "PIN required") OR an API key (BearerKeyMiddleware
// → "API key required") — both 401. client.ts reads the detail, decides which,
// and dispatches a single `ov:auth-required` CustomEvent carrying the mode; this
// gate listens for it and swaps the app tree for the matching entry form.
// `forceGate` / `forceMode` are test-only. Submitting stores the credential
// (sessionStorage for the session PIN, localStorage for the durable API key) and
// reloads so the gated requests retry with the header attached. If both gates
// are active the reload cycle re-shows this gate in whichever mode the next 401
// dictates.
export default function RemoteAuthGate({ children, forceGate = false, forceMode = 'pin' }) {
  const { t } = useTranslation();
  const [gated, setGated] = useState(forceGate);
  const [mode, setMode] = useState(forceMode);
  const [value, setValue] = useState('');

  useEffect(() => {
    const onRequired = (e) => {
      setMode(e.detail?.mode === 'apikey' ? 'apikey' : 'pin');
      setGated(true);
    };
    window.addEventListener('ov:auth-required', onRequired);
    return () => window.removeEventListener('ov:auth-required', onRequired);
  }, []);

  if (!gated) return children;

  const i18nKey = mode === 'apikey' ? 'remote_apikey_gate' : 'remote_gate';

  const submit = (e) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    // Persist, then reload so the gated requests retry with the credential
    // attached. A failed write (privacy-mode storage, etc.) must NOT reload into
    // a loop — leave the form up so the user isn't silently re-prompted forever.
    let ok = true;
    try {
      if (mode === 'apikey') ok = saveApiKey(v);
      else sessionStorage.setItem('ov_pin', v);
    } catch {
      ok = false;
    }
    if (ok) window.location.reload();
  };

  return (
    <div className="remote-auth-gate" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="remote-auth-gate__card">
        <h2>{t(`${i18nKey}.title`)}</h2>
        <p>{t(`${i18nKey}.body`)}</p>
        <label htmlFor="ov-cred">{t(`${i18nKey}.label`)}</label>
        <input
          id="ov-cred"
          type={mode === 'apikey' ? 'password' : 'text'}
          inputMode={mode === 'apikey' ? undefined : 'numeric'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit">{t(`${i18nKey}.connect`)}</button>
      </form>
    </div>
  );
}
