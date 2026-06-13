import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Cpu, Mic, MessageSquare, Activity, AlertTriangle, CheckCircle2, RefreshCw, Layers } from 'lucide-react';
import { toastErrorWithReport } from '../utils/errorToast';
import { useTranslation } from 'react-i18next';
import { listEngines, getEngineHealth } from '../api/engines';
import { Badge, Button, Segmented, Table } from '../ui';
import SupertonicLicenseDialog from './SupertonicLicenseDialog';
import './EngineCompatibilityMatrix.css';

/** Engines that gate first use behind an in-app license acceptance dialog.
 *  Phase 3 Plan 03-01 ‑‑ Supertonic-3 today; future OpenRAIL-M engines
 *  add themselves here alongside an in-tree dialog component. */
const LICENSE_DIALOGS = {
  supertonic3: SupertonicLicenseDialog,
};

/** Heuristic detector for the "license not accepted" backend reason
 *  message produced by Supertonic3Backend.is_available(). The backend
 *  message reads "Supertonic-3 license not accepted ..." so this prefix
 *  match is robust to wording tweaks. */
function reasonMentionsLicense(reason) {
  if (!reason || typeof reason !== 'string') return false;
  return /license not accepted/i.test(reason);
}

/**
 * Engine Compatibility Matrix (Plan 02-04 / ENGINE-06).
 *
 * Renders a single source-of-truth table of every registered backend in
 * a family (tts / asr / llm). Each row shows:
 *   * Engine display name
 *   * Install state (available / unavailable, with the failure reason
 *     inline when the row is unavailable)
 *   * GPU compat chips (cuda / mps / rocm / cpu)
 *   * Isolation mode (in-process or subprocess) — the visible payoff
 *     of the Plan 02-01 SubprocessBackend + Plan 02-03 IndexTTS migration
 *   * Last error (cached most-recent failure — distinguishes "currently
 *     failing" from "failed before, now working")
 *   * Test engine button — fires a `/engines/{id}/health` round-trip on
 *     demand; SubprocessBackend rows spawn-and-ping their sidecar, in-
 *     process rows fall back to `is_available()`. Latency is rendered
 *     inline next to the button.
 *
 * Cross-platform contract: this component does NOT auto-spawn any
 * sidecar on mount; the user must click Test engine. That keeps macOS /
 * Windows / Linux behaviour identical and prevents the matrix from
 * locking up a cold IndexTTS install for 30 s every time Settings
 * loads. A short 5 s cooldown on the Test button prevents click-storms.
 *
 * Props:
 *   - family: 'tts' | 'asr' | 'llm'  default 'tts'
 *   - onSelect?: (family, backendId) => Promise<void>  optional — when
 *     provided, a "Use" button appears next to "Test engine" for
 *     available, non-active rows. Lets the matrix double as an engine
 *     picker so Settings doesn't need a parallel table.
 *   - activeId?: string  the currently-active backend id for this
 *     family. Used to render the "active" badge.
 */
const FAMILY_META = {
  tts: { label: 'TTS', icon: Cpu },
  asr: { label: 'ASR', icon: Mic },
  llm: { label: 'LLM', icon: MessageSquare },
};

const ISOLATION_TONE = {
  subprocess: 'info',
  'in-process': 'neutral',
};

const GPU_LABEL = {
  cuda: 'CUDA',
  mps: 'MPS',
  rocm: 'ROCm',
  xpu: 'XPU',
  cpu: 'CPU',
};

// routing_status → badge tone + i18n key (#21). `unavailable` is intentionally
// absent: the availability badge already conveys it, so the routing badge is
// suppressed there. Any status not in this map (or a legacy payload with no
// routing_status at all) falls back to a neutral "Unknown" badge / no badge.
const ROUTING_BADGE = {
  accelerated:  { tone: 'success', k: 'engines.routingAccelerated' },
  cpu_fallback: { tone: 'warn',    k: 'engines.routingCpuFallback' },
  cpu_only:     { tone: 'neutral', k: 'engines.routingCpuOnly' },
  'n/a':        { tone: 'neutral', k: 'engines.routingRemote' },
};

const TEST_COOLDOWN_MS = 5000;

/** Subset of the unified engine entry the matrix actually reads. */
function normalizeEntry(entry) {
  return {
    id: entry.id,
    display_name: entry.display_name,
    available: !!entry.available,
    reason: entry.reason || null,
    install_hint: entry.install_hint || null,
    last_error: entry.last_error || null,
    isolation_mode: entry.isolation_mode || 'in-process',
    gpu_compat: Array.isArray(entry.gpu_compat) && entry.gpu_compat.length > 0
      ? entry.gpu_compat
      : ['cpu'],
    // Routing (#21) — may be absent on a legacy/older backend payload, in
    // which case the matrix renders exactly as before (no routing badge).
    effective_device: entry.effective_device || null,
    routing_status: entry.routing_status || null,
    routing_reason: entry.routing_reason || null,
  };
}

export default function EngineCompatibilityMatrix({
  family = 'tts',
  onSelect = null,
  activeId = null,
  // Test-friendly overrides — let the RTL suite mock the API layer
  // without resorting to module-level vi.mock incantations.
  apiListEngines = listEngines,
  apiGetEngineHealth = getEngineHealth,
}) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeFamily, setActiveFamily] = useState(family);
  // Phase 3 Plan 03-01 / TTS-05: which engine has its license dialog
  // currently open, or null. Only one dialog is ever open at a time.
  const [licenseDialogFor, setLicenseDialogFor] = useState(null);

  // health state keyed by engine id:
  //   { [id]: { inflight: boolean, ok?: boolean, message?: string,
  //              latency_ms?: number, lastClickAt?: number } }
  const [healthByEngine, setHealthByEngine] = useState({});

  useEffect(() => { setActiveFamily(family); }, [family]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await apiListEngines();
      setData(fresh);
    } catch (e) {
      const msg = e?.message || String(e);
      setError(msg);
      toastErrorWithReport(t('engines.loadFailed', { message: msg }), e);
    } finally {
      setLoading(false);
    }
  }, [apiListEngines, t]);

  useEffect(() => { reload(); }, [reload]);

  const familyData = data?.[activeFamily];
  const backends = useMemo(
    () => (familyData?.backends || []).map(normalizeEntry),
    [familyData],
  );
  const families = useMemo(
    () => Object.keys(FAMILY_META).filter((f) => data?.[f]?.backends),
    [data],
  );

  const testHealth = useCallback(async (id) => {
    const now = Date.now();
    const cur = healthByEngine[id];
    if (cur?.inflight) return;
    if (cur?.lastClickAt && now - cur.lastClickAt < TEST_COOLDOWN_MS) {
      // Click-storm cooldown — silently ignore.
      return;
    }
    setHealthByEngine((prev) => ({
      ...prev,
      [id]: { inflight: true, lastClickAt: now },
    }));
    try {
      const result = await apiGetEngineHealth(id);
      setHealthByEngine((prev) => ({
        ...prev,
        [id]: {
          inflight: false,
          ok: !!result.ok,
          message: result.message || '',
          latency_ms: Math.round(result.latency_ms || 0),
          lastClickAt: now,
        },
      }));
    } catch (e) {
      setHealthByEngine((prev) => ({
        ...prev,
        [id]: {
          inflight: false,
          ok: false,
          message: e?.message || String(e),
          latency_ms: 0,
          lastClickAt: now,
        },
      }));
    }
  }, [apiGetEngineHealth, healthByEngine]);

  const COLUMNS = [
    { key: 'name',       label: t('engines.matrixTitle').split(' ')[0] || 'Engine', flex: 3 },
    { key: 'status',     label: t('engines.status'),     width: 130, align: 'center' },
    { key: 'gpu',        label: 'GPU compat',            width: 170, align: 'left' },
    { key: 'isolation',  label: 'Isolation',             width: 110, align: 'center' },
    { key: 'action',     label: 'Actions',               width: 220, align: 'right' },
  ];

  if (loading && !data) {
    return (
      <section className="engine-matrix engine-matrix--loading" aria-busy="true">
        <span className="engine-matrix__muted">{t('engines.loading')}</span>
      </section>
    );
  }
  if (error && !data) {
    return (
      <section className="engine-matrix engine-matrix--error" role="alert">
        <AlertTriangle size={14} /> {t('engines.couldNotLoad', { message: error })}
        <Button size="sm" variant="subtle" onClick={reload} leading={<RefreshCw size={11} />}>
          {t('engines.retry')}
        </Button>
      </section>
    );
  }
  if (!familyData) return null;

  const activeBackendId = activeId ?? familyData.active;

  return (
    <section className="engine-matrix">
      <header className="engine-matrix__head">
        <h3 className="engine-matrix__title">
          <Layers size={14} /> {t('engines.matrixTitle')}
        </h3>
        <Button
          size="sm"
          variant="subtle"
          onClick={reload}
          loading={loading}
          leading={<RefreshCw size={11} />}
        >
          {t('engines.refresh')}
        </Button>
      </header>

      {families.length > 1 && (
        <Segmented
          size="sm"
          value={activeFamily}
          onChange={setActiveFamily}
          items={families.map((f) => ({
            value: f,
            title: t('engines.activeEngine', { family: FAMILY_META[f].label, engine: data[f].active }),
            label: (
              <span className="engine-matrix__tab-label">
                <span className="engine-matrix__tab-family">{FAMILY_META[f].label}</span>
                <span className="engine-matrix__tab-active">{data[f].active}</span>
              </span>
            ),
          }))}
        />
      )}

      <Table className="engine-matrix__table" role="table" aria-label={t('engines.engineCompatLabel', { family: activeFamily })}>
        <Table.Header columns={COLUMNS} />
        <div className="engine-matrix__body" role="rowgroup">
          {backends.map((b) => {
            const isActive = b.id === activeBackendId;
            const health = healthByEngine[b.id];
            return (
              <div
                key={b.id}
                role="row"
                data-engine-id={b.id}
                className={`engine-matrix__row ${b.available ? 'is-ok' : 'is-off'}`}
              >
                {/* Engine name + reason / install_hint */}
                <div role="cell" className="engine-matrix__cell engine-matrix__cell--name" style={{ flex: 3 }}>
                  <span className="engine-matrix__name">
                    {b.display_name}
                    {isActive && <Badge tone="brand" size="xs">{t('engines.active')}</Badge>}
                  </span>
                  <code className="engine-matrix__id">{b.id}</code>
                  {/* For available rows, show install_hint inline (one line — usually
                      a parenthetical like "(bundled — no extra install needed)").
                      For unavailable rows, collapse reason + install_hint + last_error
                      into a single disclosure so unavailable rows don't dwarf the matrix. */}
                  {b.available && b.install_hint && (
                    <span className="engine-matrix__hint" title={b.install_hint}>
                      {b.install_hint}
                    </span>
                  )}
                  {!b.available && (b.reason || b.install_hint || b.last_error) && (
                    <details className="engine-matrix__why">
                      <summary className="engine-matrix__why-summary">{t('engines.whyUnavailable')}</summary>
                      <div className="engine-matrix__why-body">
                        {b.reason && (
                          <span className="engine-matrix__reason">{b.reason}</span>
                        )}
                        {b.install_hint && b.install_hint !== b.reason && (
                          <span className="engine-matrix__hint">{b.install_hint}</span>
                        )}
                        {b.last_error && b.last_error !== b.reason && (
                          <span className="engine-matrix__last-error" data-testid="last-error">
                            {t('engines.lastError', { error: b.last_error })}
                          </span>
                        )}
                      </div>
                    </details>
                  )}
                </div>

                {/* Install state */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--center"
                  style={{ width: 130 }}
                  title={b.available ? t('engines.installedAndReady') : (b.reason || t('engines.notInstalled'))}
                >
                  {b.available
                    ? <Badge tone="success" size="xs"><CheckCircle2 size={10} /> {t('engines.available')}</Badge>
                    : <Badge tone="warn" size="xs"><AlertTriangle size={10} /> {t('engines.unavailable')}</Badge>}
                </div>

                {/* GPU compat chips + routing badge (the device this engine
                    will actually use on THIS machine). LLM (routing 'n/a')
                    shows a single "Remote" badge instead of device chips. */}
                <div role="cell" className="engine-matrix__cell engine-matrix__cell--gpu" style={{ width: 170 }}>
                  <div className="engine-matrix__chips">
                    {b.routing_status === 'n/a' ? (
                      <Badge tone="neutral" size="xs">{t('engines.routingRemote')}</Badge>
                    ) : (
                      <>
                        {b.gpu_compat.map((g) => {
                          const isEffective = b.routing_status
                            && b.routing_status !== 'unavailable'
                            && g === b.effective_device;
                          return (
                            <span
                              key={g}
                              className={`engine-matrix__chip engine-matrix__chip--${g}${isEffective ? ' is-effective' : ''}`}
                              title={isEffective
                                ? t('engines.routingEffectiveChip', { device: GPU_LABEL[g] || g })
                                : undefined}
                            >
                              {GPU_LABEL[g] || g.toUpperCase()}
                            </span>
                          );
                        })}
                        {/* Routing badge: known status → toned badge; unknown
                            status → neutral fallback; suppressed when the row is
                            unavailable (availability badge covers it) or legacy
                            (no routing_status → no badge). */}
                        {b.routing_status && b.available && b.routing_status !== 'unavailable' && (
                          ROUTING_BADGE[b.routing_status]
                            ? <Badge tone={ROUTING_BADGE[b.routing_status].tone} size="xs"
                                     title={b.routing_reason || undefined}>
                                {t(ROUTING_BADGE[b.routing_status].k)}
                              </Badge>
                            : <Badge tone="neutral" size="xs">{t('engines.routingUnknown')}</Badge>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {/* Isolation mode */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--center"
                  style={{ width: 110 }}
                  title={b.isolation_mode === 'subprocess'
                    ? t('engines.subprocessTitle')
                    : t('engines.inProcessTitle')}
                >
                  <Badge tone={ISOLATION_TONE[b.isolation_mode] || 'neutral'} size="xs">
                    {b.isolation_mode}
                  </Badge>
                </div>

                {/* Actions: Test engine + optional Use.
                    "Test engine" is hidden on unavailable rows by default —
                    a health check on a known-unavailable engine just confirms
                    what the matrix already says. Users re-checking after a
                    manual install can hit "Re-check" inside the disclosure. */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--actions"
                  style={{ width: 220 }}
                >
                  {b.available && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => testHealth(b.id)}
                      disabled={!!health?.inflight}
                      loading={!!health?.inflight}
                      leading={!health?.inflight && <Activity size={11} />}
                      aria-label={`Test ${b.display_name}`}
                    >
                      {health?.inflight ? t('engines.testing') : t('engines.testEngine')}
                    </Button>
                  )}
                  {!b.available && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => testHealth(b.id)}
                      disabled={!!health?.inflight}
                      loading={!!health?.inflight}
                      leading={!health?.inflight && <RefreshCw size={11} />}
                      aria-label={`Re-check ${b.display_name}`}
                    >
                      {health?.inflight ? t('engines.rechecking') : t('engines.recheck')}
                    </Button>
                  )}
                  {health && !health.inflight && (
                    <span
                      className={`engine-matrix__result engine-matrix__result--${health.ok ? 'ok' : 'fail'}`}
                      data-testid={`health-result-${b.id}`}
                      title={health.message}
                    >
                      {health.ok
                        ? t('engines.latencyMs', { ms: health.latency_ms })
                        : t('engines.failed')}
                    </span>
                  )}
                  {onSelect && b.available && !isActive && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => onSelect(activeFamily, b.id)}
                      aria-label={`Use ${b.display_name}`}
                    >
                      {t('engines.use')}
                    </Button>
                  )}
                  {/* TTS-05: license-acceptance entry point. Surfaced when
                      the backend says the user hasn't accepted the
                      engine's license yet AND we have a dialog
                      registered for that engine id. */}
                  {!b.available
                    && reasonMentionsLicense(b.reason)
                    && LICENSE_DIALOGS[b.id]
                    && (
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => setLicenseDialogFor(b.id)}
                        aria-label={`Review and accept ${b.display_name} license`}
                      >
                        {t('engines.acceptLicense')}
                      </Button>
                    )}
                </div>
              </div>
            );
          })}
          {backends.length === 0 && (
            <div className="engine-matrix__empty" role="row">
              <span role="cell">{t('engines.noBackends')}</span>
            </div>
          )}
        </div>
      </Table>
    </section>
  );
}
