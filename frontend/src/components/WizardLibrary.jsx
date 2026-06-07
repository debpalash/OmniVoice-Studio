/**
 * WizardLibrary — the first-run "stock the studio" act as ONE unified list.
 *
 * Models and engines are different things (weights vs backends), but the
 * user's question is singular — "what do I need to get?" — so every
 * installable is a row of the same grammar:
 *
 *   LED · name · chip (required / engine / optional) · size · one action
 *
 * Required models lead (they gate the wizard's continue), the TTS engines
 * follow (Use = switch, heavy installs deferred to Settings), and the long
 * tail of optional models folds behind a quiet count. Live download
 * progress rides the same SSE stream the Settings model store uses; the
 * full management surface (search, HF token, deletes) stays in Settings —
 * a first run needs a checklist, not a store.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useModels, useInstallModel } from '../api/hooks';
import { setupDownloadStreamUrl } from '../api/setup';
import { listEngines, selectEngine } from '../api/engines';

const fmtGB = (gb) => (gb == null ? '' : `${gb.toFixed(gb < 10 ? 1 : 0)} GB`);

/** Aggregate one repo's SSE file events: percent done + ETA from rates. */
function aggregate(files) {
  let done = 0;
  let total = 0;
  let rate = 0;
  for (const f of Object.values(files)) {
    done += f.downloaded || 0;
    total += f.total || 0;
    if ((f.total || 0) > (f.downloaded || 0)) rate += f.rate || 0;
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const etaSec = rate > 0 && total > done ? (total - done) / rate : null;
  return { pct, etaSec };
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return '<1m';
  return `${Math.round(seconds / 60)}m`;
}

function Row({ led, name, chip, chipTone, size, action, sub }) {
  return (
    <div className="frs-row swiz-lib__row">
      <span className={`swiz-lib__led swiz-lib__led--${led}`} aria-hidden="true" />
      <div className="frs-row__text">
        <span className="frs-row__label">
          {name}
          {chip && <span className={`frs-opt__badge swiz-lib__chip swiz-lib__chip--${chipTone}`}>{chip}</span>}
        </span>
        {sub && <span className="swiz-lib__sub">{sub}</span>}
      </div>
      <span className="frs-row__readout">{size}</span>
      {action}
    </div>
  );
}

export default function WizardLibrary() {
  const { t } = useTranslation();
  const modelsQuery = useModels();
  const installMutation = useInstallModel();
  const [engines, setEngines] = useState(null);
  const [progress, setProgress] = useState({}); // { repo_id: { phase, files } }
  const [showTail, setShowTail] = useState(false);
  const [switching, setSwitching] = useState(null);
  const [hfToken, setHfToken] = useState('');
  const [hfState, setHfState] = useState('idle'); // idle | saving | saved | error
  const esRef = useRef(null);

  // Optional HF token: unlocks gated models (e.g. pyannote speaker
  // diarization). Same persistence endpoint Settings uses — the backend
  // writes it durably so it survives restarts.
  const saveHfToken = async () => {
    const value = hfToken.trim();
    if (!value || hfState === 'saving') return;
    setHfState('saving');
    try {
      const { API } = await import('../api/client');
      const res = await fetch(`${API}/system/set-env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'HF_TOKEN', value }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setHfState('saved');
      setHfToken('');
    } catch {
      setHfState('error');
    }
  };

  const models = useMemo(() => {
    const list = modelsQuery.data;
    return Array.isArray(list) ? list : (list?.models ?? []);
  }, [modelsQuery.data]);

  // Engines: TTS family only on first run — the family the studio speaks with.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listEngines();
        if (!cancelled) setEngines(all?.tts ?? null);
      } catch { /* backend mid-boot — the wizard polls models anyway */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // One SSE stream for all rows (same channel the Settings store uses).
  useEffect(() => {
    const es = new EventSource(setupDownloadStreamUrl());
    esRef.current = es;
    es.onmessage = (evt) => {
      try {
        const ev = JSON.parse(evt.data);
        if (!ev?.repo_id) return;
        setProgress((prev) => {
          const cur = prev[ev.repo_id] || { phase: 'active', files: {} };
          if (ev.phase === 'install_start') return { ...prev, [ev.repo_id]: { phase: 'active', files: {} } };
          if (ev.phase === 'install_done' || ev.phase === 'install_error') {
            if (ev.phase === 'install_done') modelsQuery.refetch();
            const next = { ...prev };
            delete next[ev.repo_id];
            return next;
          }
          if (!ev.filename) return prev;
          const files = { ...cur.files, [ev.filename]: { downloaded: ev.downloaded || 0, total: ev.total || 0, rate: ev.rate || 0 } };
          return { ...prev, [ev.repo_id]: { ...cur, files } };
        });
      } catch { /* keepalive */ }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = (repoId) => {
    setProgress((p) => ({ ...p, [repoId]: { phase: 'active', files: {} } }));
    installMutation.mutate(repoId, {
      onError: (e) => {
        toast.error(e?.message || 'install failed');
        setProgress((p) => { const n = { ...p }; delete n[repoId]; return n; });
      },
    });
  };

  const useEngine = async (id) => {
    setSwitching(id);
    try {
      const r = await selectEngine('tts', id);
      setEngines((e) => (e ? { ...e, active: r.active } : e));
    } catch (e) {
      toast.error(e?.message || 'switch failed');
    } finally {
      setSwitching(null);
    }
  };

  const supported = models.filter((m) => m.supported !== false);
  const required = supported.filter((m) => m.required);
  const optional = supported.filter((m) => !m.required);

  const modelRow = (m, chip, chipTone) => {
    const p = progress[m.repo_id];
    const { pct, etaSec } = p ? aggregate(p.files) : { pct: null, etaSec: null };
    const downloading = !!p;
    return (
      <Row
        key={m.repo_id}
        led={m.installed ? 'ok' : downloading ? 'busy' : 'off'}
        name={m.label}
        chip={chip}
        chipTone={chipTone}
        size={fmtGB(m.size_gb)}
        sub={downloading ? (
          <span className="swiz-lib__bar"><span style={{ width: `${pct ?? 4}%` }} /></span>
        ) : null}
        action={m.installed ? (
          <span className="swiz-lib__state">✓</span>
        ) : downloading ? (
          <span className="swiz-lib__state swiz-lib__state--busy">
            {pct != null ? `${pct}%` : t('firstrun.lib_downloading', 'downloading…')}
            {etaSec != null && ` · ${t('firstrun.eta_left', { eta: formatEta(etaSec), defaultValue: '~{{eta}} left' })}`}
          </span>
        ) : (
          <button type="button" className="frs-btn frs-btn--quiet swiz-lib__act" onClick={() => install(m.repo_id)}>
            {t('firstrun.lib_download', 'Download')}
          </button>
        )}
      />
    );
  };

  return (
    <div className="swiz-lib">
      {required.map((m) => modelRow(m, t('firstrun.chip_required', 'required'), 'req'))}

      {(engines?.backends ?? []).map((b) => (
        <Row
          key={b.id}
          led={b.id === engines.active ? 'active' : b.available ? 'ok' : 'off'}
          name={b.display_name}
          chip={t('firstrun.chip_engine', 'engine')}
          chipTone="eng"
          size=""
          action={b.id === engines.active ? (
            <span className="swiz-lib__state swiz-lib__state--active">{t('firstrun.lib_active', 'active')}</span>
          ) : b.available ? (
            <button
              type="button"
              className="frs-btn frs-btn--quiet swiz-lib__act"
              disabled={switching === b.id}
              onClick={() => useEngine(b.id)}
            >
              {t('firstrun.lib_use', 'Use')}
            </button>
          ) : (
            <span className="swiz-lib__state" title={b.reason || undefined}>
              {t('firstrun.lib_in_settings', 'install later in Settings')}
            </span>
          )}
        />
      ))}

      {optional.length > 0 && !showTail && (
        <button type="button" className="frs-btn frs-btn--quiet swiz-lib__more" onClick={() => setShowTail(true)}>
          ▸ {t('firstrun.lib_show_all', { count: optional.length, defaultValue: 'Show {{count}} optional models' })}
        </button>
      )}
      {showTail && optional.map((m) => modelRow(m, t('firstrun.chip_optional', 'optional'), 'opt'))}
      {Object.keys(progress).length > 0 && (
        <p className="frs__trust">
          {t('firstrun.resume_note', 'Interrupted downloads resume automatically — closing the app is safe.')}
        </p>
      )}
      <details className="frs__advanced swiz-lib__hf">
        <summary>
          {hfState === 'saved'
            ? `✓ ${t('firstrun.hf_token_saved', 'Hugging Face token saved')}`
            : t('firstrun.hf_token_title', 'Hugging Face token (optional)')}
        </summary>
        <div className="swiz-lib__hf-body">
          <p className="frs__trust">
            {t('firstrun.hf_token_hint', 'Unlocks gated models — e.g. speaker diarization for multi-speaker dubbing (pyannote). Free account token; stays on this machine.')}
          </p>
          <div className="swiz-lib__hf-row">
            <input
              className="frs-input"
              type="password"
              placeholder="hf_…"
              value={hfToken}
              autoComplete="off"
              onChange={(e) => { setHfToken(e.target.value); if (hfState !== 'idle') setHfState('idle'); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveHfToken(); }}
              aria-label={t('firstrun.hf_token_title', 'Hugging Face token (optional)')}
            />
            <button
              type="button"
              className="frs-btn frs-btn--quiet"
              disabled={!hfToken.trim() || hfState === 'saving'}
              onClick={saveHfToken}
            >
              {hfState === 'saving'
                ? t('firstrun.hf_token_saving', 'saving…')
                : t('firstrun.hf_token_save', 'Save')}
            </button>
          </div>
          {hfState === 'error' && (
            <p className="frs__blocker">{t('firstrun.hf_token_error', 'Could not save the token — try again or set it later in Settings → Credentials.')}</p>
          )}
        </div>
      </details>
    </div>
  );
}
