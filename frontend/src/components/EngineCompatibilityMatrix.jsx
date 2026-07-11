import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Download,
} from 'lucide-react';
import { toastErrorWithReport } from '../utils/errorToast';
import { useTranslation } from 'react-i18next';
import {
  listEngines,
  getEngineHealth,
  selfTestEngine,
  installSidecarEngine,
  getSidecarInstallStatus,
} from '../api/engines';
import { listLoadedModels, unloadLoadedModel } from '../api/system';
import { copyText } from '../utils/copyText';
import { ChevronRight } from 'lucide-react';
import { Badge, Button, Segmented, Select, Table } from '../ui';
import { cn } from '@/lib/utils';
import EngineMark from './EngineMark';
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
 * a family (tts / asr / llm) as STRICT TWO-LINE rows:
 *   * Line 1 — EngineMark + display name (truncated, full name in `title`,
 *     never wraps) + active / in-memory badges.
 *   * Line 2 — compact meta: engine id, capability chips (voice cloning),
 *     hint / install hint truncated to one line (full text via `title`),
 *     the curated-model picker (mlx-audio, #981), and — on unavailable
 *     rows — the "Why unavailable?" toggle.
 *   * Aligned columns — STATUS / GPU COMPAT / ISOLATION / ACTIONS share one
 *     grid template with the header (ROW_GRID), so they line up on every
 *     row; rows carry a fixed height (ROW_SHELL) so 8+ engines fit on one
 *     screen. Unavailable-row details (reason / install hint / last error /
 *     setup snippet) open BELOW the row as an expansion panel, keeping
 *     sibling rows aligned.
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
 *   - showFamilyTabs?: boolean  default true. The TTS/ASR/LLM tab strip
 *     (Radix Segmented — roving tabindex + arrow keys) presents one family
 *     at a time over the single shared GET /engines payload. Settings →
 *     Engines mounts exactly one matrix in this mode. Pass false to pin
 *     the matrix to `family` (no switcher; the header names the family).
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

// ── Strict two-line row geometry ─────────────────────────────────────────
// One shared grid template on the header row AND every engine row — identical
// fixed tracks are what keep the STATUS / GPU COMPAT / ISOLATION / ACTIONS
// columns aligned down the whole matrix regardless of row content.
// Below 880px the three meta cells collapse onto the row's second line
// (explicit grid placement, same DOM nodes — no duplication) so the page
// never needs a horizontal scrollbar.
const ROW_GRID =
  'grid items-center gap-x-[10px] px-[10px] ' +
  'grid-cols-[minmax(0,1fr)_108px_176px_92px_232px] ' +
  'max-[880px]:grid-cols-[max-content_max-content_minmax(0,1fr)_max-content]';
// Per-cell placement for the collapsed (narrow) layout.
const CELL_NARROW = {
  name: 'max-[880px]:col-[1/4] max-[880px]:row-start-1',
  status: 'max-[880px]:col-start-1 max-[880px]:row-start-2 max-[880px]:justify-self-start',
  gpu: 'max-[880px]:col-start-2 max-[880px]:row-start-2',
  isolation: 'max-[880px]:col-start-3 max-[880px]:row-start-2 max-[880px]:justify-self-start',
  actions: 'max-[880px]:col-start-4 max-[880px]:row-[1/3]',
};
// Fixed two-line row height (desktop). Narrow rows grow to fit the collapsed
// meta line instead. `is-two-line` is a literal marker class asserted by the
// layout regression tests.
const ROW_SHELL =
  'is-two-line h-16 overflow-hidden max-[880px]:h-auto max-[880px]:min-h-16 ' +
  'max-[880px]:gap-y-[4px] max-[880px]:py-[6px]';
const MUTED = 'text-[color:var(--chrome-fg-muted,#888)]';

/** Subset of the unified engine entry the matrix actually reads. */
function normalizeEntry(entry) {
  return {
    id: entry.id,
    display_name: entry.display_name,
    available: !!entry.available,
    reason: entry.reason || null,
    // Available-but-has-advice (e.g. VoxCPM2's upgrade hint) — rendered as a
    // quiet inline line on available rows. Absent on legacy payloads.
    hint: entry.hint || null,
    // Cloning capability: only an explicit true earns the badge (null =
    // model-dependent, e.g. mlx-audio; absent = legacy payload).
    supports_cloning: entry.supports_cloning === true,
    install_hint: entry.install_hint || null,
    last_error: entry.last_error || null,
    isolation_mode: entry.isolation_mode || 'in-process',
    gpu_compat:
      Array.isArray(entry.gpu_compat) && entry.gpu_compat.length > 0 ? entry.gpu_compat : ['cpu'],
    // Copy-paste `export VAR=...` line for a path-gated opt-in engine, or null.
    setup_snippet: entry.setup_snippet || null,
    // The backend's sidecar provisioner can install this engine in-app —
    // renders an Install button; the manual snippet demotes to a fallback.
    one_click_install: entry.one_click_install === true,
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
  showFamilyTabs = true,
  // Injectable API layer — lets the RTL suite mock it without module-level
  // vi.mock incantations, and keeps the "one GET /engines per Settings open"
  // contract overridable by hosts.
  apiListEngines = listEngines,
  apiGetEngineHealth = getEngineHealth,
  apiSelfTestEngine = selfTestEngine,
  // Residency (memory) layer — same injection story. Advisory: a failure
  // here must never break the matrix, so consumers may leave the defaults
  // even where /model/loaded isn't reachable (errors are swallowed).
  apiListLoadedModels = listLoadedModels,
  apiUnloadModel = unloadLoadedModel,
  // One-click sidecar install layer — same injection story as the rest.
  apiInstallEngine = installSidecarEngine,
  apiInstallStatus = getSidecarInstallStatus,
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
  // Which unavailable engine has its "Why unavailable?" expansion panel open
  // (one at a time). The panel renders BELOW the row as its own block, so
  // sibling rows keep their fixed two-line height and stay aligned.
  const [expandedId, setExpandedId] = useState(null);
  // Memory residency: engine id → its /model/loaded entry (TTS entries and
  // sidecars carry engine_id). Advisory — load failures leave it empty and
  // the matrix renders exactly as before (no residency chips).
  const [loadedByEngine, setLoadedByEngine] = useState({});
  const [unloadingId, setUnloadingId] = useState(null);

  useEffect(() => {
    setActiveFamily(family);
  }, [family]);

  const refreshResidency = useCallback(async () => {
    try {
      const res = await apiListLoadedModels();
      const byEngine = {};
      for (const m of res?.models || []) {
        if (m?.engine_id) byEngine[m.engine_id] = m;
      }
      setLoadedByEngine(byEngine);
    } catch {
      // /model/loaded is cheap but advisory — never let it break the matrix.
      setLoadedByEngine({});
    }
  }, [apiListLoadedModels]);

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
    refreshResidency();
  }, [apiListEngines, refreshResidency, t]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Unload a resident engine's model/sidecar by its /model/loaded id. Safe by
  // contract: the model reloads lazily on the next generation.
  const unloadEngine = useCallback(
    async (engineId) => {
      const entry = loadedByEngine[engineId];
      if (!entry || unloadingId) return;
      setUnloadingId(engineId);
      try {
        await apiUnloadModel(entry.id);
      } catch (e) {
        toastErrorWithReport(t('engines.unloadFailed', { message: e?.message || String(e) }), e);
      } finally {
        setUnloadingId(null);
        refreshResidency();
      }
    },
    [apiUnloadModel, loadedByEngine, refreshResidency, t, unloadingId],
  );

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

  // One-click sidecar install (IndexTTS-2 & friends): POST starts a
  // resumable background job; this map holds the latest polled status per
  // engine id ({installed, managed, install_dir, job}).
  const [installByEngine, setInstallByEngine] = useState({});
  // At most ONE in-flight status request per engine — otherwise a slow
  // backend lets responses land out of order (an old 'running' snapshot
  // overwriting a newer 'succeeded' would restart the poller forever).
  const installInflightRef = useRef(new Set());
  // Consecutive poll failures per engine — after a few in a row the backend
  // is gone, so drop the stale snapshot instead of showing "Installing…"
  // (and hammering the endpoint) indefinitely.
  const installPollFailuresRef = useRef({});

  const refreshInstall = useCallback(
    async (id) => {
      if (installInflightRef.current.has(id)) return null; // serialize per engine
      installInflightRef.current.add(id);
      try {
        const st = await apiInstallStatus(id);
        installPollFailuresRef.current[id] = 0;
        setInstallByEngine((prev) => ({ ...prev, [id]: st }));
        return st;
      } catch {
        const n = (installPollFailuresRef.current[id] || 0) + 1;
        installPollFailuresRef.current[id] = n;
        if (n >= 4) {
          installPollFailuresRef.current[id] = 0;
          setInstallByEngine((prev) => {
            const { [id]: _stale, ...rest } = prev;
            return rest; // stops the poller; a later reload/click re-attaches
          });
        }
        return null; // advisory — polling errors never break the matrix
      } finally {
        installInflightRef.current.delete(id);
      }
    },
    [apiInstallStatus],
  );

  const startInstall = useCallback(
    async (id) => {
      setExpandedId(id); // the panel is where progress renders
      try {
        const res = await apiInstallEngine(id);
        if (res.status === 'already_installed') {
          reload();
          return;
        }
        const st = await refreshInstall(id);
        // A repair-only rerun can finish before this first status snapshot —
        // the poller below only watches 'running' jobs, so reload here too.
        if (st?.job?.state === 'succeeded') reload();
      } catch (e) {
        toastErrorWithReport(t('engines.installFailed', { message: e?.message || String(e) }), e);
      }
    },
    [apiInstallEngine, refreshInstall, reload, t],
  );

  // Poll running install jobs every 1.5 s; on success reload the matrix so
  // the row flips to available without a manual refresh. Keyed on the SET of
  // running ids (not the status map itself): every poll replaces the map, so
  // depending on it directly would tear down + recreate the interval each
  // tick, resetting the 1.5 s clock and dropping in-flight responses.
  const runningInstallKey = Object.entries(installByEngine)
    .filter(([, st]) => st?.job?.state === 'running')
    .map(([id]) => id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!runningInstallKey) return undefined;
    const ids = runningInstallKey.split(',');
    const iv = setInterval(async () => {
      for (const id of ids) {
        const st = await refreshInstall(id);
        if (st?.job?.state === 'succeeded') reload();
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [runningInstallKey, refreshInstall, reload]);

  // Re-attach to an in-flight install after a remount (Settings closed and
  // reopened while the backend job kept running): one cheap status probe per
  // installable-but-unavailable row restores the progress panel + poller.
  useEffect(() => {
    for (const b of data?.tts?.backends || []) {
      if (b.one_click_install === true && !b.available) refreshInstall(b.id);
    }
  }, [data, refreshInstall]);

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

  if (loading && !data) {
    return (
      <section
        className="engine-matrix engine-matrix--loading flex flex-col gap-[8px] items-center p-[16px]"
        aria-busy="true"
      >
        <span className={cn('engine-matrix__muted text-[13px]', MUTED)}>
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
  // Pinned mode: the header names the family (with its icon) since there is
  // no switcher to say which family this table is.
  const familyMeta = FAMILY_META[activeFamily] || FAMILY_META.tts;
  const TitleIcon = showFamilyTabs ? Layers : familyMeta.icon;

  return (
    <section className="engine-matrix flex flex-col gap-[var(--space-3,8px)]">
      <header className="engine-matrix__head flex items-center justify-between gap-[12px]">
        <h3 className="engine-matrix__title inline-flex items-center gap-[6px] m-0 text-[13px] font-semibold text-[color:var(--chrome-fg,currentColor)]">
          <TitleIcon size={14} />{' '}
          {showFamilyTabs
            ? t('engines.matrixTitle')
            : t('engines.familyMatrixTitle', { family: familyMeta.label })}
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

      {showFamilyTabs && families.length > 1 && (
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

      {/* One quiet line saying what this family does — the jargon (TTS/ASR/
          LLM) is the scariest part for first-run users. Rendered in both
          tabbed and pinned modes, always for the family on screen. */}
      <p
        className={cn('engine-matrix__family-desc m-0 -mt-[4px] text-[12px] leading-[1.4]', MUTED)}
        data-testid={`family-desc-${activeFamily}`}
      >
        {t(`engines.familyDesc_${activeFamily}`)}
      </p>

      <Table role="table" aria-label={t('engines.engineCompatLabel', { family: activeFamily })}>
        {/* Column header — shares ROW_GRID with every row so the tracks are
            pixel-identical. Hidden at narrow widths where the meta columns
            collapse into each row's second line. */}
        <div
          role="row"
          className={cn(
            ROW_GRID,
            'max-[880px]:hidden py-[4px]',
            '[border-bottom:1px_solid_var(--chrome-border,rgba(255,255,255,0.08))]',
            'font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size,10px)] font-semibold uppercase tracking-[var(--chrome-label-track,0.06em)]',
            MUTED,
          )}
        >
          <span role="columnheader">{t('engines.colEngine')}</span>
          <span role="columnheader" className="justify-self-center">
            {t('engines.status')}
          </span>
          <span role="columnheader">{t('engines.colGpuCompat')}</span>
          <span role="columnheader" className="justify-self-center">
            {t('engines.colIsolation')}
          </span>
          <span role="columnheader" className="justify-self-end">
            {t('engines.colActions')}
          </span>
        </div>
        <div className="flex flex-col pb-[8px]" role="rowgroup">
          {backends.map((b) => {
            const isActive = b.id === activeBackendId;
            const health = healthByEngine[b.id];
            const selfTest = selfTestByEngine[b.id];
            const resident = loadedByEngine[b.id] || null;
            // Real-synthesis self-test is TTS-only and meaningful only for an
            // available, in-process engine (subprocess engines keep spawn-and-
            // ping via "Test engine"; a real synth there is a sidecar cold-start).
            const canSelfTest =
              activeFamily === 'tts' && b.available && b.isolation_mode !== 'subprocess';
            // Unavailable-row detail material for the expansion panel.
            // One-click-installable rows always have a panel — it hosts the
            // install progress and the demoted manual-install fallback.
            const hasDetails =
              !b.available &&
              !!(
                b.reason ||
                b.install_hint ||
                b.last_error ||
                b.setup_snippet ||
                b.one_click_install
              );
            const install = installByEngine[b.id] || null;
            const installJob = install?.job || null;
            const installRunning = installJob?.state === 'running';
            const expanded = hasDetails && expandedId === b.id;
            const panelId = `engine-detail-${b.id}`;
            // Manual setup line (Copy button) — top-level on plain path-gated
            // rows; demoted to a collapsed "Manual install" fallback on
            // one-click-installable rows (auto-opened when the install fails,
            // since the snippet IS the recovery path then).
            const setupSnippetBlock = b.setup_snippet ? (
              <div
                className="engine-matrix__setup mt-[2px] flex flex-col gap-[3px]"
                data-testid={`setup-snippet-${b.id}`}
              >
                <span className={cn('text-[11px]', MUTED)}>{t('engines.setupSnippetLabel')}</span>
                <div className="flex flex-wrap items-center gap-[6px]">
                  <code className="engine-matrix__setup-code break-all rounded px-[6px] py-[2px] font-mono text-[11px] [background:var(--chrome-bg-inset,rgba(255,255,255,0.05))] text-[color:var(--chrome-fg,currentColor)]">
                    {b.setup_snippet}
                  </code>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => copySetup(b.id, b.setup_snippet)}
                    leading={copiedId === b.id ? <Check size={11} /> : <Copy size={11} />}
                    aria-label={t('engines.copySetup', { engine: b.display_name })}
                  >
                    {copiedId === b.id ? t('engines.copied') : t('engines.copy')}
                  </Button>
                </div>
              </div>
            ) : null;
            return (
              <React.Fragment key={b.id}>
                <div
                  role="row"
                  data-engine-id={b.id}
                  className={cn(
                    'engine-matrix__row',
                    ROW_GRID,
                    ROW_SHELL,
                    '[border-top:1px_solid_var(--chrome-border,rgba(255,255,255,0.06))]',
                    !b.available && 'opacity-[0.78]',
                  )}
                >
                  {/* Line 1: mark + name (truncated, never wraps) + badges.
                      Line 2: id + capability chips + one-line hint + details toggle. */}
                  <div
                    role="cell"
                    className={cn(
                      'engine-matrix__cell engine-matrix__cell--name flex min-w-0 flex-col justify-center gap-[2px]',
                      CELL_NARROW.name,
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-[6px]">
                      <EngineMark id={b.id} size={18} className="shrink-0" />
                      <span
                        className="engine-matrix__name min-w-0 truncate whitespace-nowrap font-semibold text-[13px] text-[color:var(--chrome-fg,currentColor)]"
                        title={b.display_name}
                      >
                        {b.display_name}
                      </span>
                      {isActive && (
                        <Badge tone="brand" size="xs" className="shrink-0">
                          {t('engines.active')}
                        </Badge>
                      )}
                      {/* Memory residency — this engine's model/sidecar is
                        loaded right now. Data-driven: only rows with a
                        matching /model/loaded entry get the chip. */}
                      {resident && (
                        <Badge
                          tone="info"
                          size="xs"
                          className="shrink-0"
                          title={t('engines.inMemoryTitle')}
                          data-testid={`resident-${b.id}`}
                        >
                          {t('engines.inMemory')}
                        </Badge>
                      )}
                    </span>
                    <span className="flex min-w-0 items-center gap-[6px] overflow-hidden whitespace-nowrap">
                      <code
                        className={cn('engine-matrix__id shrink-0 font-mono text-[11px]', MUTED)}
                      >
                        {b.id}
                      </code>
                      {/* Capability: voice cloning from reference audio. Only an
                        explicit supports_cloning=true earns it (TTS family). */}
                      {activeFamily === 'tts' && b.supports_cloning && (
                        <Badge
                          tone="neutral"
                          size="xs"
                          className="shrink-0"
                          title={t('engines.cloneCapableTitle')}
                          data-testid={`clone-badge-${b.id}`}
                        >
                          <Mic size={10} /> {t('engines.cloneCapable')}
                        </Badge>
                      )}
                      {/* #981 — mlx-audio multiplexes 7+ curated models behind this
                        one backend id (Kokoro, CSM, OuteTTS, …); without this
                        picker there's no way to load anything but the default
                        (Kokoro) even after downloading a different model's
                        weights in Settings → Models. Disabled while the row
                        itself isn't available/selectable, matching the "Use"
                        button's gating. */}
                      {b.curated_models && b.curated_models.length > 0 && (
                        <span className="engine-matrix__model-picker inline-flex shrink-0 items-center gap-[4px]">
                          <span className={cn('text-[11px]', MUTED)}>
                            {t('engines.curatedModelLabel')}
                          </span>
                          <Select
                            size="sm"
                            className="w-auto min-w-[130px]"
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
                        </span>
                      )}
                      {/* Available-but-has-advice: the engine works, but its
                        is_available() carried a suggestion (e.g. VoxCPM2's
                        ">=2.0.3" upgrade). One truncated line; full text on
                        hover/focus via title. Quiet by design. */}
                      {b.available && b.hint && (
                        <span
                          className={cn(
                            'engine-matrix__advice min-w-0 truncate text-[11px]',
                            MUTED,
                          )}
                          title={b.hint}
                          data-testid={`engine-hint-${b.id}`}
                        >
                          {b.hint}
                        </span>
                      )}
                      {b.available && b.install_hint && (
                        <span
                          className={cn('engine-matrix__hint min-w-0 truncate text-[11px]', MUTED)}
                          title={b.install_hint}
                        >
                          {b.install_hint}
                        </span>
                      )}
                      {/* Unavailable rows: reason + install hint + last error +
                        setup snippet live in an expansion panel BELOW the row,
                        so this row stays exactly two lines tall. */}
                      {hasDetails && (
                        <button
                          type="button"
                          className={cn(
                            'inline-flex shrink-0 cursor-pointer items-center gap-[3px] border-0 bg-transparent p-0 text-[11px]',
                            MUTED,
                            'hover:text-[color:var(--chrome-fg,currentColor)]',
                          )}
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          data-testid={`why-toggle-${b.id}`}
                          onClick={() => setExpandedId(expanded ? null : b.id)}
                        >
                          <ChevronRight
                            size={10}
                            className={cn(
                              'transition-transform duration-[120ms]',
                              expanded && 'rotate-90',
                            )}
                          />
                          {t('engines.whyUnavailable')}
                        </button>
                      )}
                    </span>
                  </div>

                  {/* Install state */}
                  <div
                    role="cell"
                    className={cn(
                      'engine-matrix__cell engine-matrix__cell--status justify-self-center',
                      CELL_NARROW.status,
                    )}
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
                    className={cn(
                      'engine-matrix__cell engine-matrix__cell--gpu flex min-w-0 flex-col justify-center gap-[2px] overflow-hidden',
                      CELL_NARROW.gpu,
                    )}
                  >
                    <div className="engine-matrix__chips flex flex-wrap items-center gap-[3px]">
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
                                    ? t('engines.routingEffectiveChip', {
                                        device: GPU_LABEL[g] || g,
                                      })
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
                        surface the same string as small visible text (one
                        truncated line; full text via title). Shown for
                        available, non-remote, non-unavailable rows that carry a
                        reason (cpu_fallback always; accelerated w/ a caveat). */}
                    {b.routing_reason &&
                      b.available &&
                      b.routing_status !== 'n/a' &&
                      b.routing_status !== 'unavailable' && (
                        <span
                          className={cn(
                            'engine-matrix__routing-reason min-w-0 truncate text-[10px] leading-[1.25]',
                            MUTED,
                          )}
                          title={b.routing_reason}
                          data-testid={`routing-reason-${b.id}`}
                        >
                          {b.routing_reason}
                        </span>
                      )}
                  </div>

                  {/* Isolation mode */}
                  <div
                    role="cell"
                    className={cn(
                      'engine-matrix__cell engine-matrix__cell--isolation justify-self-center',
                      CELL_NARROW.isolation,
                    )}
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

                  {/* Actions: Test engine + optional Use — right-aligned and
                      vertically centered across the row's two lines.
                      "Test engine" is hidden on unavailable rows by default —
                      a health check on a known-unavailable engine just confirms
                      what the matrix already says; those rows get "Re-check". */}
                  <div
                    role="cell"
                    className={cn(
                      'engine-matrix__cell engine-matrix__cell--actions flex h-full max-h-full flex-wrap content-center items-center justify-end justify-self-end gap-[4px] overflow-hidden py-[4px]',
                      CELL_NARROW.actions,
                    )}
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
                    {/* One-click sidecar install — the guided replacement for
                        the four manual terminal steps. Progress renders in
                        the expansion panel (auto-opened on click). */}
                    {!b.available && b.one_click_install && (
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => startInstall(b.id)}
                        disabled={installRunning}
                        loading={installRunning}
                        leading={!installRunning && <Download size={11} />}
                        data-testid={`install-${b.id}`}
                        aria-label={t('engines.installAria', { engine: b.display_name })}
                      >
                        {installRunning
                          ? t('engines.installing')
                          : installJob?.state === 'failed'
                            ? t('engines.retryInstall')
                            : t('engines.install')}
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
                        className={`engine-matrix__result max-w-[90px] truncate text-[11px] font-mono ${health.ok ? 'text-[color:var(--chrome-severity-ok,#98971a)]' : 'text-[color:var(--chrome-severity-err,#cc241d)]'}`}
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
                        className={`engine-matrix__selftest-result max-w-[150px] truncate text-[11px] font-mono ${selfTest.ok ? 'text-[color:var(--chrome-severity-ok,#98971a)]' : 'text-[color:var(--chrome-severity-err,#cc241d)]'}`}
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
                    {/* Free the memory this engine is holding right now. Only
                        offered when /model/loaded reports the entry unloadable —
                        the model reloads lazily on the next generation. */}
                    {resident?.unloadable && (
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => unloadEngine(b.id)}
                        disabled={unloadingId === b.id}
                        loading={unloadingId === b.id}
                        title={t('engines.inMemoryTitle')}
                        aria-label={`Unload ${b.display_name}`}
                      >
                        {unloadingId === b.id ? t('engines.unloading') : t('engines.unload')}
                      </Button>
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

                {/* Expansion panel — reason / install hint / last error / setup
                    snippet for an unavailable row. Rendered as its own block
                    BELOW the row (never inside it), so every sibling row keeps
                    the fixed two-line height and the columns stay aligned. */}
                {expanded && (
                  <div
                    role="row"
                    id={panelId}
                    data-testid={panelId}
                    className="engine-matrix__detail px-[10px] pb-[8px]"
                  >
                    <div
                      role="cell"
                      className="engine-matrix__why-body ml-[24px] flex flex-col gap-[3px] pl-[12px] text-[11px] [border-left:2px_solid_var(--chrome-border,rgba(255,255,255,0.08))]"
                    >
                      {b.reason && (
                        <span className="engine-matrix__reason block text-[12px] text-[color:var(--chrome-severity-warn,#d79921)]">
                          {b.reason}
                        </span>
                      )}
                      {b.install_hint && b.install_hint !== b.reason && (
                        <span className={cn('engine-matrix__hint text-[11px]', MUTED)}>
                          {b.install_hint}
                        </span>
                      )}
                      {b.last_error && b.last_error !== b.reason && (
                        <span
                          className="engine-matrix__last-error block text-[11px] text-[color:var(--chrome-severity-err,#cc241d)]"
                          data-testid="last-error"
                        >
                          {t('engines.lastError', { error: b.last_error })}
                        </span>
                      )}
                      {/* One-click install progress: per-step states + the
                          live log tail while the provisioner job runs, error
                          + remediation on failure. Poll-driven (1.5 s). */}
                      {b.one_click_install && installJob && (
                        <div
                          className="engine-matrix__install mt-[2px] flex flex-col gap-[3px]"
                          data-testid={`install-progress-${b.id}`}
                        >
                          <ul className="m-0 flex list-none flex-col gap-[1px] p-0 font-mono text-[11px]">
                            {installJob.steps.map((s) => (
                              <li
                                key={s.id}
                                className={cn(
                                  s.state === 'error' &&
                                    'text-[color:var(--chrome-severity-err,#cc241d)]',
                                  s.state === 'done' &&
                                    'text-[color:var(--chrome-severity-ok,#98971a)]',
                                  (s.state === 'pending' || s.state === 'skipped') && MUTED,
                                )}
                                data-install-step={s.id}
                                data-step-state={s.state}
                              >
                                {s.state === 'done'
                                  ? '[x]'
                                  : s.state === 'running'
                                    ? '[>]'
                                    : s.state === 'error'
                                      ? '[!]'
                                      : '[ ]'}{' '}
                                {t(`engines.installStep_${s.id}`, { defaultValue: s.id })}
                                {s.id === 'fetch_weights' &&
                                  s.state === 'running' &&
                                  installJob.weights_progress?.pct != null &&
                                  ` — ${Math.round(installJob.weights_progress.pct * 100)}%`}
                              </li>
                            ))}
                          </ul>
                          {installRunning && installJob.log.length > 0 && (
                            <code
                              className={cn(
                                'block max-w-full truncate font-mono text-[10px]',
                                MUTED,
                              )}
                              title={installJob.log.slice(-12).join('\n')}
                            >
                              {installJob.log[installJob.log.length - 1]}
                            </code>
                          )}
                          {installJob.state === 'failed' && (
                            <span className="block text-[11px] text-[color:var(--chrome-severity-err,#cc241d)]">
                              {installJob.error}
                              {installJob.remediation ? ` — ${installJob.remediation}` : ''}
                            </span>
                          )}
                          {installJob.state === 'succeeded' && (
                            <span className="block text-[11px] text-[color:var(--chrome-severity-ok,#98971a)]">
                              {t('engines.installDone')}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Copy-paste-ready setup line for a path-gated opt-in
                          engine (IndexTTS/MOSS-v1.5/dots/Confucius4) — the
                          exact `export VAR=…` so users don't hunt the docs.
                          On one-click-installable rows it demotes to a
                          collapsed "Manual install" fallback (forced open when
                          the install failed — it's the recovery path then). */}
                      {setupSnippetBlock &&
                        (b.one_click_install ? (
                          <details
                            className="engine-matrix__manual mt-[2px]"
                            data-testid={`manual-install-${b.id}`}
                            {...(installJob?.state === 'failed' ? { open: true } : {})}
                          >
                            <summary
                              className={cn('cursor-pointer select-none text-[11px]', MUTED)}
                            >
                              {t('engines.manualInstall')}
                            </summary>
                            {setupSnippetBlock}
                          </details>
                        ) : (
                          setupSnippetBlock
                        ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
          {backends.length === 0 && (
            <div
              className={cn('engine-matrix__empty p-[24px] text-center text-[13px]', MUTED)}
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
