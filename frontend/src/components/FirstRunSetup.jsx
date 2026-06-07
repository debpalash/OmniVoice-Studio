/**
 * First-run install setup screen — "studio console" treatment.
 *
 * Rendered by BootstrapSplash while the Rust side is parked in the
 * `awaiting_setup` stage — nothing has been downloaded or installed yet.
 * The user picks install mode (installed/portable), storage locations,
 * compute variant, network mirrors and update channel; every chosen
 * directory is live-checked for free space against the minimum the install
 * needs (Rust re-validates on submit — the UI gate is a mirror, not the
 * authority). "Start installation" is the only thing that kicks off the
 * bootstrap.
 *
 * Design language: powering on a piece of studio hardware. Serif masthead
 * (Source Serif 4), engraved mono panel labels (IBM Plex Mono), a breathing
 * waveform, and disk space rendered as LED capacity meters. Desktop-first:
 * a wide two-column deck of rack panels floating directly on the backdrop
 * (no outer chassis box), collapsing to one column on narrow windows. All
 * motion is CSS-only (transform/opacity) and honors prefers-reduced-motion;
 * every asset is bundled — a first run may be on a restricted network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { LANGUAGES } from '../i18n';
import { useAppStore } from '../store';
import './FirstRunSetup.css';

const APP_VERSION = __APP_VERSION__ || '0.0.0';
const GIB = 1024 * 1024 * 1024;

const fmtGB = (bytes) =>
  bytes == null ? '—' : `${(bytes / GIB).toFixed(bytes < 10 * GIB ? 1 : 0)} GB`;

const invoke = async (...args) => {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
  return tauriInvoke(...args);
};

/** Debounced live probe of one install target (free space / writability). */
function useTargetCheck(path) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!path) { setCheck(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await invoke('check_install_target', { path });
        if (!cancelled) setCheck(res);
      } catch { if (!cancelled) setCheck(null); }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [path]);
  return check;
}

/** Breathing waveform masthead — bar heights are stable per mount. */
function Waveform({ bars = 96 }) {
  const heights = useMemo(
    () => Array.from({ length: bars }, (_, i) => {
      // Deterministic pseudo-random silhouette: layered sines read as speech
      // cadence (syllables + phrase envelope) rather than white noise.
      const t = i / bars;
      const v = Math.abs(
        Math.sin(t * Math.PI * 7.3) * 0.55 +
        Math.sin(t * Math.PI * 2.1 + 1.2) * 0.3 +
        Math.sin(t * Math.PI * 17.0 + 0.4) * 0.15
      );
      return 0.18 + v * 0.82;
    }),
    [bars],
  );
  return (
    <div className="frs-wave" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="frs-wave__bar"
          style={{ '--h': h, '--d': `${(i * 73) % 1400}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * LED capacity meter: how much of the volume's free space this install
 * consumes. Lit = consumed by the install, dim = remaining headroom.
 * Overflows (need > free) clamp to full and switch to the alarm color.
 */
function CapacityMeter({ need, free }) {
  const ratio = free > 0 ? need / free : 1;
  const pct = Math.min(100, Math.max(3, ratio * 100));
  return (
    <div
      className={`frs-meter ${ratio > 1 ? 'frs-meter--over' : ''}`}
      role="img"
      aria-label={`${fmtGB(need)} / ${fmtGB(free)}`}
    >
      <span className="frs-meter__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** One storage location row: label, path, space readout, Change… picker.
 *  The LED meter only appears when it carries information — the disk is
 *  getting tight (install would consume >35% of free space) or blocked.
 *  At 449 GB free vs 9 GB needed a bar is a meaningless sliver; a quiet
 *  one-line readout is cleaner. */
function StorageRow({ label, desc, path, need, check, onPick }) {
  const { t } = useTranslation();
  const lowSpace = check?.freeBytes != null && check.freeBytes < need;
  const notWritable = check && !check.writable;
  const blocked = lowSpace || notWritable;
  const tight = check?.freeBytes != null && need / check.freeBytes > 0.35;
  return (
    <div className={`frs-row ${blocked ? 'frs-row--blocked' : ''}`}>
      <div className="frs-row__text" title={desc}>
        <span className="frs-row__label">{label}</span>
        <code className="frs-row__path" title={path}>{path}</code>
      </div>
      <div className="frs-row__gauge">
        {(blocked || tight) && check?.freeBytes != null && (
          <CapacityMeter need={need} free={check.freeBytes} />
        )}
        <span className={`frs-row__readout ${lowSpace ? 'is-low' : ''}`}>
          {check == null
            ? t('firstrun.checking', 'checking…')
            : notWritable
              ? t('firstrun.not_writable', 'not writable')
              : <>
                  {t('firstrun.needs', { size: fmtGB(need), defaultValue: 'needs ~{{size}}' })}
                  {' · '}
                  {t('firstrun.free', { size: fmtGB(check.freeBytes), defaultValue: '{{size}} free' })}
                </>}
        </span>
      </div>
      {onPick && (
        <button type="button" className="frs-btn frs-btn--quiet" onClick={onPick}>
          {t('firstrun.change', 'Change…')}
        </button>
      )}
    </div>
  );
}

/** Section: engraved mono title + rule — structure by line, not by box. */
function Panel({ title, delay, className = '', children }) {
  return (
    <section className={`frs-panel frs-rise ${className}`} style={{ '--rise': delay }}>
      <h2 className="frs-panel__title">{title}</h2>
      {children}
    </section>
  );
}

/** Arrow-key navigation for a radio group (WAI-ARIA radio pattern):
 *  Left/Up selects the previous enabled option, Right/Down the next.
 *  Selection follows focus, exactly like native radios. */
export function radioGroupNav(e, values, current, select) {
  let delta = 0;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') delta = 1;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') delta = -1;
  else return;
  e.preventDefault();
  const idx = Math.max(0, values.indexOf(current));
  const next = values[(idx + delta + values.length) % values.length];
  select(next);
}

/** LED radio option — used for install mode, compute and update channel.
 *  Verbosity diet: the description unfolds only on the selected card; the
 *  rest expose it as a tooltip. One expanded card per group keeps the page
 *  calm without hiding information. Roving tabindex: only the selected
 *  option is in the tab order; arrows move within the group. */
function OptionCard({ active, disabled, onSelect, name, desc, badge, compact }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      className={`frs-opt ${compact ? 'frs-opt--compact' : ''} ${active ? 'is-active' : ''}`}
      disabled={disabled}
      title={desc}
      onClick={() => !disabled && onSelect()}
    >
      <span className="frs-opt__led" aria-hidden="true" />
      <span className="frs-opt__head">
        <span className="frs-opt__name">{name}</span>
        {badge && <span className="frs-opt__badge">{badge}</span>}
      </span>
    </button>
  );
}

/** Fixed caption slot under a radio group: two reserved lines, the active
 *  option's description swaps in — the layout never shifts on selection. */
function GroupCaption({ text }) {
  return <p className="frs__opt-caption" aria-live="polite">{text}</p>;
}

export default function FirstRunSetup() {
  const { t } = useTranslation();
  const locale = useAppStore((s) => s.locale);
  const setLocale = useAppStore((s) => s.setLocale);

  const [setup, setSetup] = useState(null);   // get_setup_state payload
  const [plan, setPlan] = useState(null);     // user's editable choices
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await invoke('get_setup_state');
        if (!mounted.current) return;
        setSetup(s);
        setPlan({
          installMode: s.portable.available && s.defaults.installMode === 'portable' ? 'portable' : 'installed',
          envDir: s.defaults.envDir,
          dataDir: s.defaults.dataDir,
          modelsDir: s.defaults.modelsDir,
          region: s.defaults.region,
          updateChannel: s.defaults.updateChannel,
          // Pre-select ROCm when the machine looks AMD — detection is shown
          // on the card, and the user can always flip back to Auto.
          torchVariant: s.hardware?.kind === 'rocm' ? 'rocm' : s.defaults.torchVariant,
          mirrors: { pypiIndex: '', hfEndpoint: '', pythonDownloads: '' },
        });
      } catch (e) {
        if (mounted.current) setServerError(String(e));
      }
    })();
  }, []);

  const portable = plan?.installMode === 'portable';
  const req = setup?.requirements;
  const hw = setup?.hardware;
  const combinedNeed = req ? req.envBytes + req.modelsBytes + req.dataBytes : 0;

  // Live target probes — in portable mode only the anchor folder matters.
  const portableBase = setup?.portable?.baseDir || '';
  const envCheck = useTargetCheck(portable ? null : plan?.envDir);
  const dataCheck = useTargetCheck(portable ? null : plan?.dataDir);
  const modelsCheck = useTargetCheck(portable ? null : plan?.modelsDir);
  const portableCheck = useTargetCheck(portable ? portableBase : null);

  // Mirror of the Rust gate: group targets by filesystem, sum requirements,
  // block when any volume falls short or isn't writable.
  const blockers = useMemo(() => {
    if (!plan || !req) return [{ key: 'loading' }];
    const targets = portable
      ? [{ check: portableCheck, need: combinedNeed, label: portableBase }]
      : [
          { check: envCheck, need: req.envBytes, label: plan.envDir },
          { check: dataCheck, need: req.dataBytes, label: plan.dataDir },
          { check: modelsCheck, need: req.modelsBytes, label: plan.modelsDir },
        ];
    if (targets.some((x) => x.check == null)) return [{ key: 'loading' }];
    const out = [];
    for (const { check, label } of targets) {
      if (!check.writable) out.push({ key: 'not_writable', label });
    }
    const byFs = new Map();
    for (const { check, need } of targets) {
      const k = check.fsKey || check.path;
      const cur = byFs.get(k) || { need: 0, free: check.freeBytes };
      cur.need += need;
      cur.free = Math.min(cur.free ?? Infinity, check.freeBytes ?? Infinity);
      byFs.set(k, cur);
    }
    for (const { need, free } of byFs.values()) {
      if (free != null && free < need) out.push({ key: 'space', need, free });
    }
    return out;
  }, [plan, req, portable, portableBase, combinedNeed, envCheck, dataCheck, modelsCheck, portableCheck]);

  const pickDir = useCallback(async (field) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, defaultPath: plan?.[field] || undefined });
      if (typeof dir === 'string' && dir) setPlan((p) => ({ ...p, [field]: dir }));
    } catch (e) { console.error('folder pick failed', e); }
  }, [plan]);

  const set = useCallback((patch) => setPlan((p) => ({ ...p, ...patch })), []);

  const start = useCallback(async () => {
    if (!plan || submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const clean = (s) => (s && s.trim() ? s.trim() : null);
      await invoke('complete_setup', {
        plan: {
          installMode: plan.installMode,
          envDir: clean(plan.envDir),
          dataDir: clean(plan.dataDir),
          modelsDir: clean(plan.modelsDir),
          region: plan.region,
          locale,
          updateChannel: plan.updateChannel,
          torchVariant: plan.torchVariant,
          mirrors: {
            pypiIndex: clean(plan.mirrors.pypiIndex),
            hfEndpoint: clean(plan.mirrors.hfEndpoint),
            pythonDownloads: clean(plan.mirrors.pythonDownloads),
          },
        },
      });
      // Success: the stage poll in App.jsx leaves `awaiting_setup` and the
      // normal bootstrap progress UI takes over. Nothing to do here.
    } catch (e) {
      if (mounted.current) { setServerError(String(e)); setSubmitting(false); }
    }
  }, [plan, submitting, locale]);

  if (!setup || !plan) {
    return (
      <div className="frs">
        <div className="frs__atmo" aria-hidden="true" />
        <div className="frs__loading">
          {serverError
            ? <pre className="frs__error">{serverError}</pre>
            : t('firstrun.loading', 'Preparing setup…')}
        </div>
      </div>
    );
  }

  const blocked = blockers.length > 0;
  const spaceBlocker = blockers.find((b) => b.key === 'space');
  // The full machine identity — OS/distro · arch · GPU · CPU · RAM — the
  // exact matrix cell this install is for (and what bug reports cite).
  const hwLine = hw
    ? [
        [hw.osName, hw.arch].filter(Boolean).join(' '),
        hw.gpu,
        hw.cpuCores ? `${hw.cpuCores}×CPU` : null,
        hw.ramGb ? `${hw.ramGb} GB RAM` : null,
      ].filter(Boolean).join(' · ')
    : null;
  // ROCm wheels are Linux-only — never offer a choice that can't work on
  // this platform (Rust clamps it server-side too).
  const rocmAvailable = setup.os === 'linux';

  return (
    <div className="frs">
      <div className="frs__atmo" aria-hidden="true" />
      <div className="frs__deck">

        {/* ── Masthead: waveform + serif headline + serial plate ────────── */}
        <header className="frs__mast frs-rise" style={{ '--rise': 0 }} data-tauri-drag-region>
          <Waveform />
          {/* Journey rail: this page is stage 1 of the install flow. */}
          <nav className="frs-wsteps frs-wsteps--journey" aria-label={t('firstrun.title', 'Set up OmniVoice Studio')}>
            <span className="frs-wstep is-active">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.stage_setup', 'Setup')}
            </span>
            <span className="frs-wstep">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.installing_title', 'Installing')}
            </span>
            <span className="frs-wstep">
              <span className="frs-wstep__led" aria-hidden="true" />
              {t('firstrun.stage_models', 'Models & engines')}
            </span>
          </nav>
          <div className="frs__mast-row">
            <div className="frs__mast-text">
              <h1 className="frs__title">{t('firstrun.title', 'Set up OmniVoice Studio')}</h1>
              <p className="frs__subtitle">
                {t('firstrun.subtitle', 'Nothing is installed yet — review where everything goes, then start. You can change these later in Settings.')}
              </p>
            </div>
            <div className="frs__mast-meta">
              {/* Language + download region live together: the two "where am
                  I" choices, settled before anything else. Custom mirrors
                  hang quietly beneath them, where they belong. */}
              <div className="frs__mast-selects">
                <select
                  className="frs-select frs-select--lang"
                  value={locale}
                  onChange={(e) => { setLocale(e.target.value); i18n.changeLanguage(e.target.value); }}
                  aria-label={t('firstrun.language', 'Language')}
                >
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                </select>
                <select
                  className="frs-select frs-select--lang"
                  value={plan.region}
                  onChange={(e) => set({ region: e.target.value })}
                  aria-label={t('firstrun.region_label', 'Download region')}
                >
                  <option value="auto">🌐 {t('bootstrap.auto_detect', 'Auto-detect')}</option>
                  <option value="global">🌐 {t('bootstrap.region_global', 'Global (direct)')}</option>
                  <option value="china">🇨🇳 {t('bootstrap.region_china', 'China (mirror)')}</option>
                  <option value="russia">🇷🇺 {t('bootstrap.region_russia', 'Russia (mirror)')}</option>
                  <option value="restricted">🌍 {t('bootstrap.region_restricted', 'Restricted (mirror)')}</option>
                </select>
              </div>
              <details className="frs__advanced frs__advanced--mast">
                <summary>{t('firstrun.mirrors_title', 'Custom mirrors (advanced)')}</summary>
                <div className="frs__mirror-fields">
                  {[
                    ['pypiIndex', t('firstrun.mirror_pypi', 'PyPI index URL'), 'https://mirrors.aliyun.com/pypi/simple/'],
                    ['hfEndpoint', t('firstrun.mirror_hf', 'Hugging Face endpoint'), 'https://hf-mirror.com'],
                    ['pythonDownloads', t('firstrun.mirror_python', 'Python downloads mirror'), 'https://gh-proxy.com/…'],
                  ].map(([field, label, ph]) => (
                    <label key={field} className="frs-field">
                      <span>{label}</span>
                      <input
                        className="frs-input"
                        type="url"
                        placeholder={ph}
                        value={plan.mirrors[field]}
                        onChange={(e) => set({ mirrors: { ...plan.mirrors, [field]: e.target.value } })}
                      />
                    </label>
                  ))}
                </div>
              </details>
            </div>
          </div>
        </header>

        {/* ── Wide deck: storage rail (left) + decision rail (right) ────── */}
        <div className="frs__grid">
          <div className="frs__col frs__col--main">

            <Panel title={t('firstrun.mode_title', 'Install mode')} delay={1}>
              <div className="frs__options frs__options--two" role="radiogroup" aria-label={t('firstrun.mode_title', 'Install mode')} onKeyDown={(e) => radioGroupNav(e, setup.portable.available ? ['installed', 'portable'] : ['installed'], plan.installMode, (v) => set({ installMode: v }))}>
                <OptionCard
                  active={!portable}
                  onSelect={() => set({ installMode: 'installed' })}
                  name={t('firstrun.mode_installed', 'Installed')}
                  desc={t('firstrun.mode_installed_desc', 'Uses standard system folders. Recommended for most users.')}
                />
                <OptionCard
                  active={portable}
                  disabled={!setup.portable.available}
                  onSelect={() => set({ installMode: 'portable' })}
                  name={t('firstrun.mode_portable', 'Portable')}
                  desc={setup.portable.available
                    ? t('firstrun.mode_portable_desc', 'Everything lives in one folder next to the app — move it to another disk or machine as a unit.')
                    : t('firstrun.mode_portable_unavailable', 'Unavailable: the folder next to the app is not writable.')}
                />
              </div>
              <GroupCaption text={portable
                ? t('firstrun.mode_portable_desc', 'Everything lives in one folder next to the app — move it to another disk or machine as a unit.')
                : t('firstrun.mode_installed_desc', 'Uses standard system folders. Recommended for most users.')} />
            </Panel>

            <Panel title={t('firstrun.storage_title', 'Storage')} delay={2}>
              {portable ? (
                <StorageRow
                  label={t('firstrun.portable_folder', 'Portable folder')}
                  desc={t('firstrun.portable_folder_desc', 'App environment, models, and your voice data — one folder, fully movable.')}
                  path={portableBase}
                  need={combinedNeed}
                  check={portableCheck}
                />
              ) : (
                <>
                  <StorageRow
                    label={t('firstrun.env_dir', 'App environment')}
                    desc={t('firstrun.env_dir_desc', 'Python runtime and AI libraries.')}
                    path={plan.envDir}
                    need={req.envBytes}
                    check={envCheck}
                    onPick={() => pickDir('envDir')}
                  />
                  <StorageRow
                    label={t('firstrun.data_dir', 'Voice data & projects')}
                    desc={t('firstrun.data_dir_desc', 'Your voices, dubs, outputs and project database.')}
                    path={plan.dataDir}
                    need={req.dataBytes}
                    check={dataCheck}
                    onPick={() => pickDir('dataDir')}
                  />
                  <StorageRow
                    label={t('firstrun.models_dir', 'Model cache')}
                    desc={t('firstrun.models_dir_desc', 'Downloaded AI models — the largest and most relocatable part.')}
                    path={plan.modelsDir}
                    need={req.modelsBytes}
                    check={modelsCheck}
                    onPick={() => pickDir('modelsDir')}
                  />
                </>
              )}
            </Panel>

          </div>

          <div className="frs__col frs__col--side">

            <Panel title={t('firstrun.compute_title', 'Compute')} delay={2}>
              {hwLine && (
                <div className="frs__hw" title={hwLine}>
                  <span className="frs__hw-dot" aria-hidden="true" />
                  <span className="frs__hw-label">
                    {t('firstrun.compute_detected', { defaultValue: 'Detected' })}
                  </span>
                  <span className="frs__hw-value">{hwLine}</span>
                </div>
              )}
              <div
                className="frs__options"
                role="radiogroup"
                aria-label={t('firstrun.compute_title', 'Compute')}
                onKeyDown={(e) => radioGroupNav(e, rocmAvailable ? ['auto', 'rocm'] : ['auto'], plan.torchVariant, (v) => set({ torchVariant: v }))}
              >
                <OptionCard
                  compact
                  active={plan.torchVariant === 'auto'}
                  onSelect={() => set({ torchVariant: 'auto' })}
                  name={t('firstrun.compute_auto', 'Auto (NVIDIA CUDA / Apple MPS / CPU)')}
                  desc={t('firstrun.compute_auto_desc', 'Picks the best backend on this machine at runtime — CUDA on NVIDIA, MPS on Apple Silicon, CPU otherwise.')}
                  badge={hw?.kind === 'cuda' || hw?.kind === 'mps'
                    ? t('firstrun.compute_match', { defaultValue: 'matches this machine' })
                    : null}
                />
                {rocmAvailable && (
                  <OptionCard
                    compact
                    active={plan.torchVariant === 'rocm'}
                    onSelect={() => set({ torchVariant: 'rocm' })}
                    name={t('firstrun.compute_rocm', 'AMD GPU (ROCm, Linux)')}
                    desc={t('firstrun.compute_rocm_desc', 'Installs PyTorch ROCm wheels for AMD graphics cards on Linux. Leave on Auto if unsure.')}
                    badge={hw?.kind === 'rocm'
                      ? t('firstrun.compute_match', { defaultValue: 'matches this machine' })
                      : null}
                  />
                )}
              </div>
              <GroupCaption text={plan.torchVariant === 'rocm'
                ? t('firstrun.compute_rocm_desc', 'Installs PyTorch ROCm wheels for AMD graphics cards on Linux. Leave on Auto if unsure.')
                : t('firstrun.compute_auto_desc', 'Picks the best backend on this machine at runtime — CUDA on NVIDIA, MPS on Apple Silicon, CPU otherwise.')} />
            </Panel>

            <Panel title={t('firstrun.channel_label', 'Update channel')} delay={3}>
              <div
                className="frs__options"
                role="radiogroup"
                aria-label={t('firstrun.channel_label', 'Update channel')}
                onKeyDown={(e) => radioGroupNav(e, ['stable', 'preview'], plan.updateChannel, (v) => set({ updateChannel: v }))}
              >
                <OptionCard
                  compact
                  active={plan.updateChannel === 'stable'}
                  onSelect={() => set({ updateChannel: 'stable' })}
                  name={t('firstrun.channel_stable', 'Stable')}
                  desc={t('firstrun.channel_stable_desc', 'Tested releases only — updates arrive after community validation.')}
                />
                <OptionCard
                  compact
                  active={plan.updateChannel === 'preview'}
                  onSelect={() => set({ updateChannel: 'preview' })}
                  name={t('firstrun.channel_preview', 'Preview (latest main)')}
                  desc={t('firstrun.channel_preview_desc', 'Rolling builds from the latest main — new engines and fixes first, occasional rough edges.')}
                />
              </div>
              <GroupCaption text={plan.updateChannel === 'preview'
                ? t('firstrun.channel_preview_desc', 'Rolling builds from the latest main — new engines and fixes first, occasional rough edges.')
                : t('firstrun.channel_stable_desc', 'Tested releases only — updates arrive after community validation.')} />
            </Panel>
          </div>
        </div>

        {/* ── Footer: gate + arm ────────────────────────────────────────── */}
        <footer className="frs__foot frs-rise" style={{ '--rise': 5 }}>
          {serverError && <pre className="frs__error">{serverError}</pre>}
          {spaceBlocker && (
            <p className="frs__blocker">
              {t('firstrun.insufficient_space', {
                need: fmtGB(spaceBlocker.need),
                free: fmtGB(spaceBlocker.free),
                defaultValue: 'Not enough free space: this layout needs ~{{need}} on one disk, only {{free}} available. Pick a different location.',
              })}
            </p>
          )}
          {blockers.some((b) => b.key === 'not_writable') && (
            <p className="frs__blocker">
              {t('firstrun.blocked_not_writable', 'A chosen folder is not writable — pick a different location.')}
            </p>
          )}
          <div className="frs__foot-row">
            <span className="frs__totals">
              <span className="frs__plate">OVS&thinsp;·&thinsp;v{APP_VERSION}</span>
              <span className="frs__totals-sep" aria-hidden="true">—</span>
              {t('firstrun.total_required', {
                size: fmtGB(combinedNeed),
                defaultValue: 'Total disk needed: ~{{size}} (one-time download on first use)',
              })}
            </span>
            <button
              type="button"
              className={`frs-btn frs-btn--primary ${!blocked && !submitting ? 'is-armed' : ''}`}
              disabled={blocked || submitting}
              onClick={start}
            >
              <span className="frs-btn__led" aria-hidden="true" />
              {submitting
                ? t('firstrun.starting', 'Starting…')
                : t('firstrun.start', 'Start installation')}
            </button>
          </div>
          {/* The product's whole thesis, said where the user decides. */}
          <p className="frs__trust">
            {t('firstrun.trust_line', 'Everything runs and stays on this machine — no account, no cloud, no telemetry.')}
          </p>
        </footer>
      </div>
    </div>
  );
}
