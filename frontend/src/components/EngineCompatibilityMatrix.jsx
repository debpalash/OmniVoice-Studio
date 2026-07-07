import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Cpu,
  Mic,
  MessageSquare,
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Layers,
  Volume2,
  Copy,
  Check,
} from 'lucide-react';
import { toastErrorWithReport } from '../utils/errorToast';
import { useTranslation } from 'react-i18next';
import { listEngines, getEngineHealth, selfTestEngine } from '../api/engines';
import { copyText } from '../utils/copyText';
import { ChevronRight } from 'lucide-react';
import { Badge, Button, Segmented, Select, Table } from '../ui';
import { cn } from '@/lib/utils';
import SupertonicLicenseDialog from './SupertonicLicenseDialog';

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
 *   - onSelect?: (family, backendId, modelId?) => Promise<void>  optional —
 *     when provided, a "Use" button appears next to "Test engine" for
 *     available, non-active rows. Lets the matrix double as an engine
 *     picker so Settings doesn't need a parallel table. The optional third
 *     arg is set only by mlx-audio's curated-model picker (#981).
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

// GPU compat chip — base + per-device tint. Migrated from
// EngineCompatibilityMatrix.css (the `.engine-matrix__chip*` color system).
const CHIP_BASE =
  'inline-block px-[6px] py-px text-[10px] font-mono font-semibold tracking-[0.04em] uppercase rounded border select-none';
const CHIP_DEVICE = {
  cuda: 'text-[#76b900] border-[color:color-mix(in_srgb,#76b900_45%,transparent)] bg-[color:color-mix(in_srgb,#76b900_10%,transparent)]',
  mps: 'text-[#b8b8b8] border-[color:color-mix(in_srgb,#b8b8b8_45%,transparent)] bg-[color:color-mix(in_srgb,#b8b8b8_10%,transparent)]',
  rocm: 'text-[#ed1c24] border-[color:color-mix(in_srgb,#ed1c24_45%,transparent)] bg-[color:color-mix(in_srgb,#ed1c24_10%,transparent)]',
  xpu: 'text-[#0071c5] border-[color:color-mix(in_srgb,#0071c5_45%,transparent)] bg-[color:color-mix(in_srgb,#0071c5_10%,transparent)]',
  cpu: 'text-[color:var(--chrome-fg-muted,#888)] border-[color:var(--chrome-border-strong,rgba(255,255,255,0.18))] bg-transparent',
};
// The "device this host actually uses" highlight (#21). `is-effective` is kept
// as a literal marker class — the matrix test asserts the chip carries it.
const CHIP_EFFECTIVE =
  'is-effective shadow-[0_0_0_1px_var(--chrome-accent,#fe8019)] border-[var(--chrome-accent,#fe8019)] text-[color:var(--chrome-fg,#eee)] font-bold';
const chipCls = (device, effective) =>
  cn(CHIP_BASE, CHIP_DEVICE[device] || CHIP_DEVICE.cpu, effective && CHIP_EFFECTIVE);

// routing_status → badge tone + i18n key (#21). `unavailable` is intentionally
// absent: the availability badge already conveys it, so the routing badge is
// suppressed there. Any status not in this map (or a legacy payload with no
// routing_status at all) falls back to a neutral "Unknown" badge / no badge.
const ROUTING_BADGE = {
  accelerated: { tone: 'success', k: 'engines.routingAccelerated' },
  cpu_fallback: { tone: 'warn', k: 'engines.routingCpuFallback' },
  cpu_only: { tone: 'neutral', k: 'engines.routingCpuOnly' },
  'n/a': { tone: 'neutral', k: 'engines.routingRemote' },
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
    gpu_compat:
      Array.isArray(entry.gpu_compat) && entry.gpu_compat.length > 0 ? entry.gpu_compat : ['cpu'],
    // Copy-paste `export VAR=...` line for a path-gated opt-in engine, or null.
    setup_snippet: entry.setup_snippet || null,
    // Routing (#21) — may be absent on a legacy/older backend payload, in
    // which case the matrix renders exactly as before (no routing badge).
    effective_device: entry.effective_device || null,
    routing_status: entry.routing_status || null,
    routing_reason: entry.routing_reason || null,
    // #981 — mlx-audio ONLY: the curated-model roster + current pick.
    // null/absent on every other backend, which never renders a picker.
    curated_models: Array.isArray(entry.curated_models) ? entry.curated_models : null,
    active_model_id: entry.active_model_id || null,
  };
}

/** Human duration: "0.4s" for ≥1 s, "820 ms" below — keeps the self-test
 *  result compact whether a cold model load or a warm sub-second synth. */
function fmtDuration(ms) {
  const n = Number(ms) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)} ms`;
}

export default function EngineCompatibilityMatrix({
  family = 'tts',
  onSelect = null,
  activeId = null,
  // Test-friendly overrides — let the RTL suite mock the API layer
  // without resorting to module-level vi.mock incantations.
  apiListEngines = listEngines,
  apiGetEngineHealth = getEngineHealth,
  apiSelfTestEngine = selfTestEngine,
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
  // Self-test (real tiny synthesis) state keyed by engine id, same shape as
  // health plus { duration_ms, sample_rate, audio_seconds, timed_out }.
  const [selfTestByEngine, setSelfTestByEngine] = useState({});
  // Which engine's setup snippet was just copied (transient ✓ affordance).
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    setActiveFamily(family);
  }, [family]);

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

  useEffect(() => {
    reload();
  }, [reload]);

  const familyData = data?.[activeFamily];
  const backends = useMemo(() => (familyData?.backends || []).map(normalizeEntry), [familyData]);
  const families = useMemo(
    () => Object.keys(FAMILY_META).filter((f) => data?.[f]?.backends),
    [data],
  );

  const testHealth = useCallback(
    async (id) => {
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
    },
    [apiGetEngineHealth, healthByEngine],
  );

  const runSelfTest = useCallback(
    async (id) => {
      const now = Date.now();
      const cur = selfTestByEngine[id];
      if (cur?.inflight) return;
      if (cur?.lastClickAt && now - cur.lastClickAt < TEST_COOLDOWN_MS) {
        // Click-storm cooldown — silently ignore. The backend also serialises
        // self-tests, so this is belt-and-braces against stacked model loads.
        return;
      }
      setSelfTestByEngine((prev) => ({
        ...prev,
        [id]: { inflight: true, lastClickAt: now },
      }));
      try {
        const result = await apiSelfTestEngine(id);
        setSelfTestByEngine((prev) => ({
          ...prev,
          [id]: { inflight: false, lastClickAt: now, ...result },
        }));
      } catch (e) {
        setSelfTestByEngine((prev) => ({
          ...prev,
          [id]: {
            inflight: false,
            ok: false,
            message: e?.message || String(e),
            lastClickAt: now,
          },
        }));
      }
    },
    [apiSelfTestEngine, selfTestByEngine],
  );

  const copySetup = useCallback(async (id, snippet) => {
    const ok = await copyText(snippet);
    if (!ok) return;
    setCopiedId(id);
    setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
  }, []);

  // #981 — mlx-audio's curated-model picker. Reuses the same onSelect the
  // "Use" button calls, with the curated model key as the optional third
  // arg, then reloads so active_model_id reflects the new pick immediately.
  const changeModel = useCallback(
    async (id, modelId) => {
      if (!onSelect || !modelId) return;
      await onSelect(activeFamily, id, modelId);
      reload();
    },
    [onSelect, activeFamily, reload],
  );

  const COLUMNS = [
    { key: 'name', label: t('engines.matrixTitle').split(' ')[0] || 'Engine', flex: 3 },
    { key: 'status', label: t('engines.status'), width: 130, align: 'center' },
    { key: 'gpu', label: 'GPU compat', width: 170, align: 'left' },
    { key: 'isolation', label: 'Isolation', width: 110, align: 'center' },
    { key: 'action', label: 'Actions', width: 220, align: 'right' },
  ];

  if (loading && !data) {
    return (
      <section
        className="engine-matrix engine-matrix--loading flex flex-col gap-[8px] items-center p-[16px]"
        aria-busy="true"
      >
        <span className="engine-matrix__muted text-[color:var(--chrome-fg-muted,#888)] text-[13px]">
          {t('engines.loading')}
        </span>
      </section>
    );
  }
  if (error && !data) {
    return (
      <section
        className="engine-matrix engine-matrix--error flex flex-col gap-[8px] items-center p-[16px]"
        role="alert"
      >
        <AlertTriangle size={14} /> {t('engines.couldNotLoad', { message: error })}
        <Button size="sm" variant="subtle" onClick={reload} leading={<RefreshCw size={11} />}>
          {t('engines.retry')}
        </Button>
      </section>
    );
  }
  if (!familyData) return null;

  const activeBackendId = activeId ?? familyData.active;
  // TTS-05: the license dialog registered for the engine awaiting acceptance
  // (or null). Capitalized so JSX renders it as a component below.
  const LicenseDialog = licenseDialogFor ? LICENSE_DIALOGS[licenseDialogFor] : null;

  return (
    <section className="engine-matrix flex flex-col gap-[var(--space-3,8px)]">
      <header className="engine-matrix__head flex items-center justify-between gap-[12px]">
        <h3 className="engine-matrix__title inline-flex items-center gap-[6px] m-0 text-[13px] font-semibold text-[color:var(--chrome-fg,currentColor)]">
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
            title: t('engines.activeEngine', {
              family: FAMILY_META[f].label,
              engine: data[f].active,
            }),
            label: (
              <span className="engine-matrix__tab-label inline-flex flex-col items-center gap-0 leading-[1.1] px-[2px] py-[1px]">
                <span className="engine-matrix__tab-family text-[12px] font-bold tracking-[0.02em]">
                  {FAMILY_META[f].label}
                </span>
                <span className="engine-matrix__tab-active text-[9px] font-mono opacity-[0.65] lowercase tracking-[0] mt-[1px]">
                  {data[f].active}
                </span>
              </span>
            ),
          }))}
        />
      )}

      <Table
        className="w-full overflow-x-auto [&_.ui-table-header]:min-w-[840px]"
        role="table"
        aria-label={t('engines.engineCompatLabel', { family: activeFamily })}
      >
        <Table.Header columns={COLUMNS} />
        <div className="flex min-w-[840px] flex-col pb-[12px]" role="rowgroup">
          {backends.map((b) => {
            const isActive = b.id === activeBackendId;
            const health = healthByEngine[b.id];
            const selfTest = selfTestByEngine[b.id];
            // Real-synthesis self-test is TTS-only and meaningful only for an
            // available, in-process engine (subprocess engines keep spawn-and-
            // ping via "Test engine"; a real synth there is a sidecar cold-start).
            const canSelfTest =
              activeFamily === 'tts' && b.available && b.isolation_mode !== 'subprocess';
            return (
              <div
                key={b.id}
                role="row"
                data-engine-id={b.id}
                className={`engine-matrix__row flex items-start gap-[8px] py-[8px] px-[10px] [border-top:1px_solid_var(--chrome-border,rgba(255,255,255,0.06))] min-h-[56px] ${b.available ? '' : 'opacity-[0.78]'}`}
              >
                {/* Engine name + reason / install_hint */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--name flex shrink-0 flex-col items-start gap-[2px] min-w-0"
                  style={{ flex: 3 }}
                >
                  <span className="engine-matrix__name inline-flex items-center gap-[6px] font-semibold text-[13px] text-[color:var(--chrome-fg,currentColor)]">
                    {b.display_name}
                    {isActive && (
                      <Badge tone="brand" size="xs">
                        {t('engines.active')}
                      </Badge>
                    )}
                  </span>
                  <code className="engine-matrix__id font-mono text-[11px] text-[color:var(--chrome-fg-muted,#888)]">
                    {b.id}
                  </code>
                  {/* #981 — mlx-audio multiplexes 7+ curated models behind this
                      one backend id (Kokoro, CSM, OuteTTS, …); without this
                      picker there's no way to load anything but the default
                      (Kokoro) even after downloading a different model's
                      weights in Settings → Models. Disabled while the row
                      itself isn't available/selectable, matching the "Use"
                      button's gating. */}
                  {b.curated_models && b.curated_models.length > 0 && (
                    <div className="engine-matrix__model-picker flex items-center gap-[6px] mt-[2px]">
                      <span className="text-[11px] text-[color:var(--chrome-fg-muted,#888)]">
                        {t('engines.curatedModelLabel')}
                      </span>
                      <Select
                        size="sm"
                        className="w-auto min-w-[150px]"
                        value={b.active_model_id || ''}
                        disabled={!onSelect || !b.available}
                        onChange={(e) => changeModel(b.id, e.target.value)}
                        aria-label={t('engines.curatedModelAria', { engine: b.display_name })}
                        data-testid={`curated-model-select-${b.id}`}
                      >
                        {b.curated_models.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  {/* For available rows, show install_hint inline (one line — usually
                      a parenthetical like "(bundled — no extra install needed)").
                      For unavailable rows, collapse reason + install_hint + last_error
                      into a single disclosure so unavailable rows don't dwarf the matrix. */}
                  {b.available && b.install_hint && (
                    <span
                      className="engine-matrix__hint text-[11px] text-[color:var(--chrome-fg-muted,#888)]"
                      title={b.install_hint}
                    >
                      {b.install_hint}
                    </span>
                  )}
                  {!b.available && (b.reason || b.install_hint || b.last_error) && (
                    <details className="group text-[11px] mt-[2px]">
                      <summary className="flex cursor-pointer list-none select-none items-center gap-[4px] py-px text-[color:var(--chrome-fg-muted,#888)] hover:text-[color:var(--chrome-fg,currentColor)] [&::-webkit-details-marker]:hidden">
                        <ChevronRight
                          size={10}
                          className="transition-transform duration-[120ms] group-open:rotate-90"
                        />
                        {t('engines.whyUnavailable')}
                      </summary>
                      <div className="engine-matrix__why-body flex flex-col gap-[3px] mt-[4px] pl-[12px] [border-left:2px_solid_var(--chrome-border,rgba(255,255,255,0.08))]">
                        {b.reason && (
                          <span className="engine-matrix__reason text-[12px] text-[color:var(--chrome-severity-warn,#d79921)] block max-w-full overflow-hidden text-ellipsis">
                            {b.reason}
                          </span>
                        )}
                        {b.install_hint && b.install_hint !== b.reason && (
                          <span className="engine-matrix__hint text-[11px] text-[color:var(--chrome-fg-muted,#888)]">
                            {b.install_hint}
                          </span>
                        )}
                        {b.last_error && b.last_error !== b.reason && (
                          <span
                            className="engine-matrix__last-error text-[11px] text-[color:var(--chrome-severity-err,#cc241d)] block"
                            data-testid="last-error"
                          >
                            {t('engines.lastError', { error: b.last_error })}
                          </span>
                        )}
                        {/* Copy-paste-ready setup line for a path-gated opt-in
                            engine (IndexTTS/MOSS-v1.5/dots/Confucius4) — the
                            exact `export VAR=…` so users don't hunt the docs. */}
                        {b.setup_snippet && (
                          <div
                            className="engine-matrix__setup flex flex-col gap-[3px] mt-[2px]"
                            data-testid={`setup-snippet-${b.id}`}
                          >
                            <span className="text-[11px] text-[color:var(--chrome-fg-muted,#888)]">
                              {t('engines.setupSnippetLabel')}
                            </span>
                            <div className="flex items-center gap-[6px] flex-wrap">
                              <code className="engine-matrix__setup-code font-mono text-[11px] px-[6px] py-[2px] rounded [background:var(--chrome-bg-inset,rgba(255,255,255,0.05))] text-[color:var(--chrome-fg,currentColor)] break-all">
                                {b.setup_snippet}
                              </code>
                              <Button
                                size="sm"
                                variant="subtle"
                                onClick={() => copySetup(b.id, b.setup_snippet)}
                                leading={
                                  copiedId === b.id ? <Check size={11} /> : <Copy size={11} />
                                }
                                aria-label={t('engines.copySetup', { engine: b.display_name })}
                              >
                                {copiedId === b.id ? t('engines.copied') : t('engines.copy')}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>

                {/* Install state */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--center flex items-center shrink-0 justify-center"
                  style={{ width: 130 }}
                  title={
                    b.available
                      ? t('engines.installedAndReady')
                      : b.reason || t('engines.notInstalled')
                  }
                >
                  {b.available ? (
                    <Badge tone="success" size="xs">
                      <CheckCircle2 size={10} /> {t('engines.available')}
                    </Badge>
                  ) : (
                    <Badge tone="warn" size="xs">
                      <AlertTriangle size={10} /> {t('engines.unavailable')}
                    </Badge>
                  )}
                </div>

                {/* GPU compat chips + routing badge (the device this engine
                    will actually use on THIS machine). LLM (routing 'n/a')
                    shows a single "Remote" badge instead of device chips. */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--gpu flex flex-col items-start justify-center shrink-0 gap-[3px]"
                  style={{ width: 170 }}
                >
                  <div className="engine-matrix__chips inline-flex flex-wrap gap-[4px]">
                    {b.routing_status === 'n/a' ? (
                      <Badge tone="neutral" size="xs">
                        {t('engines.routingRemote')}
                      </Badge>
                    ) : (
                      <>
                        {b.gpu_compat.map((g) => {
                          const isEffective =
                            b.routing_status &&
                            b.routing_status !== 'unavailable' &&
                            g === b.effective_device;
                          return (
                            <span
                              key={g}
                              className={chipCls(g, isEffective)}
                              title={
                                isEffective
                                  ? t('engines.routingEffectiveChip', { device: GPU_LABEL[g] || g })
                                  : undefined
                              }
                            >
                              {GPU_LABEL[g] || g.toUpperCase()}
                            </span>
                          );
                        })}
                        {/* Routing badge: known status → toned badge; unknown
                            status → neutral fallback; suppressed when the row is
                            unavailable (availability badge covers it) or legacy
                            (no routing_status → no badge). */}
                        {b.routing_status &&
                          b.available &&
                          b.routing_status !== 'unavailable' &&
                          (ROUTING_BADGE[b.routing_status] ? (
                            <Badge
                              tone={ROUTING_BADGE[b.routing_status].tone}
                              size="xs"
                              title={b.routing_reason || undefined}
                            >
                              {t(ROUTING_BADGE[b.routing_status].k)}
                            </Badge>
                          ) : (
                            <Badge tone="neutral" size="xs">
                              {t('engines.routingUnknown')}
                            </Badge>
                          ))}
                      </>
                    )}
                  </div>
                  {/* Make the routing reason reachable without a hover: the
                      badge `title` is invisible to keyboard + touch users, so
                      surface the same string as small visible text. Shown for
                      available, non-remote, non-unavailable rows that carry a
                      reason (cpu_fallback always; accelerated w/ a caveat). */}
                  {b.routing_reason &&
                    b.available &&
                    b.routing_status !== 'n/a' &&
                    b.routing_status !== 'unavailable' && (
                      <span
                        className="engine-matrix__routing-reason text-[10px] leading-[1.25] text-[color:var(--chrome-fg-muted,#888)]"
                        data-testid={`routing-reason-${b.id}`}
                      >
                        {b.routing_reason}
                      </span>
                    )}
                </div>

                {/* Isolation mode */}
                <div
                  role="cell"
                  className="engine-matrix__cell engine-matrix__cell--center flex items-center shrink-0 justify-center"
                  style={{ width: 110 }}
                  title={
                    b.isolation_mode === 'subprocess'
                      ? t('engines.subprocessTitle')
                      : t('engines.inProcessTitle')
                  }
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
                  className="engine-matrix__cell engine-matrix__cell--actions flex items-center shrink-0 justify-end gap-[6px] flex-wrap"
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
                      className={`engine-matrix__result text-[11px] font-mono ${health.ok ? 'text-[color:var(--chrome-severity-ok,#98971a)]' : 'text-[color:var(--chrome-severity-err,#cc241d)]'}`}
                      data-testid={`health-result-${b.id}`}
                      title={health.message}
                    >
                      {health.ok
                        ? // A subprocess row spawns + pings its sidecar → the
                          // latency is a real round-trip. An in-process row only
                          // imports + `is_available()`-checks (a ~0 ms liveness
                          // probe, not a synthesis test), so label it as such
                          // rather than a misleading "0 ms" latency.
                          b.isolation_mode === 'subprocess'
                          ? t('engines.latencyMs', { ms: health.latency_ms })
                          : t('engines.depsOk')
                        : t('engines.failed')}
                    </span>
                  )}
                  {/* Self-test: a real tiny synthesis proving the in-process TTS
                      engine emits audio (not just imports). Guarded — TTS only,
                      available + in-process only, user click only, cooldown +
                      backend timeout bound it. */}
                  {canSelfTest && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => runSelfTest(b.id)}
                      disabled={!!selfTest?.inflight}
                      loading={!!selfTest?.inflight}
                      leading={!selfTest?.inflight && <Volume2 size={11} />}
                      aria-label={`Self-test ${b.display_name}`}
                    >
                      {selfTest?.inflight ? t('engines.selfTesting') : t('engines.selfTest')}
                    </Button>
                  )}
                  {canSelfTest && selfTest && !selfTest.inflight && (
                    <span
                      className={`engine-matrix__selftest-result text-[11px] font-mono ${selfTest.ok ? 'text-[color:var(--chrome-severity-ok,#98971a)]' : 'text-[color:var(--chrome-severity-err,#cc241d)]'}`}
                      data-testid={`selftest-result-${b.id}`}
                      title={selfTest.message}
                    >
                      {selfTest.ok
                        ? t('engines.selfTestOk', {
                            seconds: Number(selfTest.audio_seconds ?? 0).toFixed(2),
                            khz: selfTest.sample_rate
                              ? Math.round(selfTest.sample_rate / 1000)
                              : '?',
                            took: fmtDuration(selfTest.duration_ms),
                          })
                        : selfTest.timed_out
                          ? t('engines.selfTestTimedOut')
                          : t('engines.selfTestFailed')}
                    </span>
                  )}
                  {onSelect && b.available && !isActive && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={async () => {
                        // Await the pick, then re-fetch so the active badge,
                        // Use buttons, and family-tab captions reflect the new
                        // engine immediately — no manual Refresh needed (#…).
                        await onSelect(activeFamily, b.id);
                        reload();
                      }}
                      aria-label={`Use ${b.display_name}`}
                    >
                      {t('engines.use')}
                    </Button>
                  )}
                  {/* TTS-05: license-acceptance entry point. Surfaced when
                      the backend says the user hasn't accepted the
                      engine's license yet AND we have a dialog
                      registered for that engine id. */}
                  {!b.available && reasonMentionsLicense(b.reason) && LICENSE_DIALOGS[b.id] && (
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
            <div
              className="engine-matrix__empty p-[24px] text-center text-[color:var(--chrome-fg-muted,#888)] text-[13px]"
              role="row"
            >
              <span role="cell">{t('engines.noBackends')}</span>
            </div>
          )}
        </div>
      </Table>

      {/* TTS-05: license-acceptance dialog for the selected engine. Mounted
          only while `licenseDialogFor` is set (one at a time). On Accept the
          dialog POSTs the acceptance then `onAccepted` reloads the matrix so
          the row flips from unavailable → available without a manual refresh. */}
      {LicenseDialog && (
        <LicenseDialog
          open
          onClose={() => setLicenseDialogFor(null)}
          onAccepted={() => {
            setLicenseDialogFor(null);
            reload();
          }}
        />
      )}
    </section>
  );
}
