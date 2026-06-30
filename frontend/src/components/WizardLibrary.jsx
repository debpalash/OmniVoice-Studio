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

/** Human-readable byte size, e.g. 734003200 -> "700 MB", 1610612736 -> "1.5 GB". */
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** Instantaneous download rate, e.g. 5452595 -> "5.2 MB/s". Blank when idle. */
export function fmtRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
  const kb = bytesPerSec / 1024;
  return `${Math.max(1, Math.round(kb))} KB/s`;
}

/**
 * A model is a "platform pick" when it explicitly targets one of THIS host's
 * platform tags (the MLX mac-ARM speedups, CUDA-tuned variants, …) — the best
 * optional models for this machine, surfaced by default instead of buried in
 * the tail. Models with no `platforms` field are universal (not a pick — they
 * ride the fold). Pure + exported so the split is unit-testable.
 */
export function isPlatformPick(model, platformTags) {
  return (
    Array.isArray(model?.platforms) &&
    Array.isArray(platformTags) &&
    model.platforms.some((p) => platformTags.includes(p))
  );
}

/** Overall progress from the backend's authoritative `aggregate` SSE event.
 * This is the TRUSTWORTHY source: under parallel/segmented fetch the per-file
 * tqdm events are unreliable (big weight shards may report total/rate as 0),
 * so summing them on the frontend gave wrong numbers — e.g. "8% · 1 KB/s ·
 * 0.0 MB left". The backend computes one windowed rate + ETA + bytes_done /
 * total_bytes (seeded by the dry-run preflight), which is what we render. Pure
 * + exported for unit tests. Returns null until totals are known. */
export function progressFromAgg(agg) {
  if (!agg || !(agg.totalBytes > 0)) return null;
  const pct = Math.min(100, Math.round((agg.bytesDone / agg.totalBytes) * 100));
  const remaining = agg.totalBytes > agg.bytesDone ? agg.totalBytes - agg.bytesDone : null;
  return { pct, remaining, rate: agg.rate || 0, etaSec: agg.etaSeconds ?? null };
}

/** Fallback: aggregate one repo's per-file SSE events when the authoritative
 * `aggregate` event hasn't arrived yet. Exported (pure) for unit tests. */
export function aggregate(files) {
  let done = 0;
  let total = 0;
  let rate = 0;
  for (const f of Object.values(files || {})) {
    done += f.downloaded || 0;
    total += f.total || 0;
    if ((f.total || 0) > (f.downloaded || 0)) rate += f.rate || 0;
  }
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const remaining = total > done ? total - done : null;
  const etaSec = rate > 0 && remaining ? remaining / rate : null;
  return { pct, etaSec, rate, remaining };
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
          {chip && (
            <span className={`frs-opt__badge swiz-lib__chip swiz-lib__chip--${chipTone}`}>
              {chip}
            </span>
          )}
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
  const esRef = useRef(null);

  const models = useMemo(() => {
    const list = modelsQuery.data;
    return Array.isArray(list) ? list : (list?.models ?? []);
  }, [modelsQuery.data]);

  // Host platform tags (e.g. ['darwin', 'darwin-arm64']) so we can surface the
  // models tuned for THIS machine by default instead of burying them.
  const platformTags = useMemo(() => {
    const d = modelsQuery.data;
    return Array.isArray(d) ? [] : (d?.platform_tags ?? []);
  }, [modelsQuery.data]);

  // Engines: TTS family only on first run — the family the studio speaks with.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listEngines();
        if (!cancelled) setEngines(all?.tts ?? null);
      } catch {
        /* backend mid-boot — the wizard polls models anyway */
      }
    })();
    return () => {
      cancelled = true;
    };
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
          // Lifecycle markers (`install_*`) gate reset/refetch; per-file tqdm
          // phases ('start'|'progress'|'done') only update byte counts — a
          // file-level 'done' must NOT clear the repo, multi-file snapshots
          // finish files long before the repo's `install_done` arrives.
          // (Full phase taxonomy: SetupProgressEvent in api/setup.ts.)
          if (ev.phase === 'install_start')
            return { ...prev, [ev.repo_id]: { phase: 'active', files: {} } };
          if (ev.phase === 'install_done' || ev.phase === 'install_error') {
            if (ev.phase === 'install_done') modelsQuery.refetch();
            const next = { ...prev };
            delete next[ev.repo_id];
            return next;
          }
          // Authoritative overall progress (download_aggregator): one windowed
          // rate + ETA + bytes_done/total_bytes for the whole repo. Preferred
          // over summing per-file events, which is unreliable under parallel/
          // segmented fetch (the source of the "8% · 1 KB/s · 0.0 MB left" bug).
          if (ev.phase === 'aggregate') {
            return {
              ...prev,
              [ev.repo_id]: {
                ...cur,
                agg: {
                  bytesDone: ev.bytes_done || 0,
                  totalBytes: ev.total_bytes || 0,
                  rate: ev.rate || 0,
                  etaSeconds: ev.eta_seconds ?? null,
                  filesDone: ev.files_done || 0,
                  filesTotal: ev.files_total || 0,
                },
              },
            };
          }
          if (!ev.filename) return prev;
          const files = {
            ...cur.files,
            [ev.filename]: {
              downloaded: ev.downloaded || 0,
              total: ev.total || 0,
              rate: ev.rate || 0,
            },
          };
          return { ...prev, [ev.repo_id]: { ...cur, files } };
        });
      } catch {
        /* keepalive */
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const install = (repoId) => {
    setProgress((p) => ({ ...p, [repoId]: { phase: 'active', files: {} } }));
    installMutation.mutate(repoId, {
      onError: (e) => {
        toast.error(e?.message || 'install failed');
        setProgress((p) => {
          const n = { ...p };
          delete n[repoId];
          return n;
        });
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
  const optionalAll = supported.filter((m) => !m.required);
  // Platform-tuned optionals lead (shown by default); the universal long tail
  // still folds behind a quiet count.
  const platformPicks = optionalAll.filter((m) => isPlatformPick(m, platformTags));
  const tail = optionalAll.filter((m) => !isPlatformPick(m, platformTags));

  const modelRow = (m, chip, chipTone, note) => {
    const p = progress[m.repo_id];
    // Prefer the backend's authoritative aggregate; fall back to per-file sums
    // only until that event arrives (then to nulls when nothing's streaming).
    const { pct, etaSec, rate, remaining } =
      progressFromAgg(p?.agg) ||
      (p ? aggregate(p.files) : { pct: null, etaSec: null, rate: 0, remaining: null });
    const downloading = !!p;
    // Live telemetry line: "5.2 MB/s · 700 MB left · ~3m". Each part only shows
    // once the SSE stream has the data, so early on it degrades to "downloading…".
    const rateStr = fmtRate(rate);
    const remainStr = fmtBytes(remaining);
    const etaStr = etaSec != null ? formatEta(etaSec) : '';
    const statParts = [
      pct != null ? `${pct}%` : null,
      rateStr || null,
      remainStr
        ? t('firstrun.size_left', { size: remainStr, defaultValue: '{{size}} left' })
        : null,
      etaStr ? t('firstrun.eta_left', { eta: etaStr, defaultValue: '~{{eta}} left' }) : null,
    ].filter(Boolean);
    return (
      <Row
        key={m.repo_id}
        led={m.installed ? 'ok' : downloading ? 'busy' : 'off'}
        name={m.label}
        chip={chip}
        chipTone={chipTone}
        size={fmtGB(m.size_gb)}
        sub={
          downloading ? (
            <span className="swiz-lib__bar">
              <span style={{ width: `${pct ?? 4}%` }} />
            </span>
          ) : (
            note || null
          )
        }
        action={
          m.installed ? (
            <span className="swiz-lib__state">✓</span>
          ) : downloading ? (
            <span className="swiz-lib__state swiz-lib__state--busy">
              {statParts.length
                ? statParts.join(' · ')
                : t('firstrun.lib_downloading', 'downloading…')}
            </span>
          ) : (
            <button
              type="button"
              className="frs-btn frs-btn--quiet swiz-lib__act"
              onClick={() => install(m.repo_id)}
            >
              {t('firstrun.lib_download', 'Download')}
            </button>
          )
        }
      />
    );
  };

  return (
    <div className="swiz-lib">
      {required.map((m) => modelRow(m, t('firstrun.chip_required', 'required'), 'req'))}

      {/* Optional models tuned for THIS machine — shown by default with the
          catalog note explaining why (e.g. "5× faster on Apple Silicon"). */}
      {platformPicks.map((m) =>
        modelRow(m, t('firstrun.chip_recommended', 'recommended'), 'rec', m.note),
      )}

      {(engines?.backends ?? []).map((b) => (
        <Row
          key={b.id}
          led={b.id === engines.active ? 'active' : b.available ? 'ok' : 'off'}
          name={b.display_name}
          chip={t('firstrun.chip_engine', 'engine')}
          chipTone="eng"
          size=""
          action={
            b.id === engines.active ? (
              <span className="swiz-lib__state swiz-lib__state--active">
                {t('firstrun.lib_active', 'active')}
              </span>
            ) : b.available ? (
              <button
                type="button"
                className="frs-btn frs-btn--quiet swiz-lib__act"
                disabled={switching === b.id}
                // eslint-disable-next-line react-hooks/rules-of-hooks -- useEngine is an action fn, not a React hook
                onClick={() => useEngine(b.id)}
              >
                {t('firstrun.lib_use', 'Use')}
              </button>
            ) : (
              <span className="swiz-lib__state" title={b.reason || undefined}>
                {t('firstrun.lib_in_settings', 'install later in Settings')}
              </span>
            )
          }
        />
      ))}

      {tail.length > 0 && !showTail && (
        <button
          type="button"
          className="frs-btn frs-btn--quiet swiz-lib__more"
          onClick={() => setShowTail(true)}
        >
          ▸{' '}
          {t('firstrun.lib_show_all', {
            count: tail.length,
            defaultValue: 'Show {{count}} more models',
          })}
        </button>
      )}
      {showTail && tail.map((m) => modelRow(m, t('firstrun.chip_optional', 'optional'), 'opt'))}
      {Object.keys(progress).length > 0 && (
        <p className="frs__trust">
          {t(
            'firstrun.resume_note',
            'Interrupted downloads resume automatically — closing the app is safe.',
          )}
        </p>
      )}
    </div>
  );
}
