import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Film,
  Volume2,
  FileText,
  Package,
  Music,
  Layers,
  Download,
  Check,
  Globe,
  Zap,
  X,
  Building2,
} from 'lucide-react';
import { Button, Segmented, Badge } from '../ui';

// ── Tailwind class fragments for the stateful chrome that used to live in
// ExportModal.css (track chips, tab strip, toggles). Kept as module constants
// so the conditional state logic reads cleanly at the call sites.
const TRACK_BASE =
  'inline-flex items-center gap-[6px] px-[10px] py-[4px] rounded-[var(--chrome-radius-pill)] border text-[length:var(--text-sm)] cursor-pointer transition-[border-color,color,background] duration-[var(--dur-fast)]';
const trackCls = (on, kind) => {
  if (on && kind === 'dub')
    return `${TRACK_BASE} border-[var(--chrome-accent-border)] bg-[var(--chrome-accent-bg)] text-[var(--chrome-accent)]`;
  if (on)
    return `${TRACK_BASE} border-transparent bg-[var(--chrome-hover-bg)] text-[var(--chrome-fg)]`;
  return `${TRACK_BASE} border-transparent text-[var(--chrome-fg-muted)]`;
};
const TAB_BASE =
  'inline-flex items-center gap-[6px] px-[12px] py-[6px] bg-transparent border-0 border-b-2 cursor-pointer text-[length:var(--text-sm)] transition-[color,border-color] duration-[var(--dur-fast)]';
const tabCls = (active) =>
  active
    ? `${TAB_BASE} border-b-[var(--chrome-accent)] text-[var(--chrome-accent)]`
    : `${TAB_BASE} border-b-transparent text-[var(--chrome-fg-muted)] hover:text-[var(--chrome-fg)]`;
const TOGGLE_CLS =
  'inline-flex items-center gap-[6px] text-[length:var(--text-sm)] text-[var(--chrome-fg)] cursor-pointer [&_input]:accent-[var(--color-brand)]';
const TOGGLE_INDENT_CLS =
  'inline-flex items-center gap-[6px] ml-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--chrome-fg-muted)] cursor-pointer [&_input]:accent-[var(--color-brand)]';

/**
 * ExportModal — comprehensive export panel for the dubbing studio.
 *
 * Tabs: Video · Audio · Subtitles · Package. Each tab owns a small bundle of
 * format/track/quality controls. The shared track list at the top lets the
 * user pick which languages participate in whatever tab they land on — so
 * "export all dubs as SRT" and "mux these 3 tracks into the MP4" share one
 * source of truth instead of living as three separate dropdowns.
 */
const PRESETS = {
  youtube: {
    labelKey: 'exportModal.preset_youtube',
    tab: 'video',
    format: 'mp4',
    preserveBg: true,
    burnSubs: false,
    defaultTrack: 'dub',
  },
  archive: {
    labelKey: 'exportModal.preset_archive',
    tab: 'video',
    format: 'mp4',
    preserveBg: true,
    burnSubs: false,
    includeAll: true,
  },
  web: {
    labelKey: 'exportModal.preset_web',
    tab: 'video',
    format: 'mp4',
    preserveBg: true,
    burnSubs: true,
    dualSubs: false,
  },
  podcast: {
    labelKey: 'exportModal.preset_podcast',
    tab: 'audio',
    audioFormat: 'mp3',
    mp3Bitrate: '192',
    preserveBg: false,
  },
  studyset: {
    labelKey: 'exportModal.preset_studyset',
    tab: 'subs',
    subsFormat: 'srt',
    subsDual: true,
  },
};

export default function ExportModal({
  open,
  onClose,
  jobId,
  filename,
  dubTracks,
  dubLangCode,
  preserveBg,
  setPreserveBg,
  defaultTrack,
  setDefaultTrack,
  exportTracks,
  setExportTracks,
  dualSubs,
  setDualSubs,
  burnSubs,
  setBurnSubs,
  API,
  triggerDownload,
  handleDubDownload,
  handleAudioExport,
  segmentCount = 0,
  timingStrategy = '',
  onEnterprise,
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('video');

  // ── Tab-local state (not persisted across sessions — each open is fresh).
  const [videoFormat, setVideoFormat] = useState('mp4'); // future: webm/mov
  const [audioFormat, setAudioFormat] = useState('wav'); // wav | mp3
  const [mp3Bitrate, setMp3Bitrate] = useState('192'); // 128/192/256/320
  const [audioBatch, setAudioBatch] = useState('each'); // each | primary — per-lang or single file
  const [audioPrimaryLang, setAudioPrimaryLang] = useState(dubLangCode || '');
  const [subsFormat, setSubsFormat] = useState('srt'); // srt | vtt | both
  const [subsDual, setSubsDual] = useState(!!dualSubs);
  const [subsBatch, setSubsBatch] = useState('target'); // target | all-dubs

  // Reflect the parent's dual/burn once, then own them locally so the modal
  // can toy with them without committing on cancel.
  useEffect(() => {
    setSubsDual(!!dualSubs);
  }, [open, dualSubs]);

  // ── Drawer dismiss — ESC closes; click-outside closes. The drawer is a
  // bottom sheet (non-blocking), so background interactions stay live.
  const drawerRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    const onDown = (e) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target)) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onClose]);

  const allTracks = useMemo(() => {
    const out = [{ code: 'original', label: t('exportModal.original'), kind: 'original' }];
    (dubTracks || []).forEach((t) => out.push({ code: t, label: t.toUpperCase(), kind: 'dub' }));
    return out;
  }, [dubTracks, t]);

  const selectedTracks = allTracks.filter((t) => exportTracks[t.code] !== false);
  const selectedDubs = selectedTracks.filter((t) => t.kind === 'dub');

  const toggleTrack = (code) =>
    setExportTracks((prev) => ({ ...prev, [code]: prev[code] === false ? true : false }));
  const setAllTracks = (on) =>
    setExportTracks(Object.fromEntries(allTracks.map((t) => [t.code, on])));
  const setDubsOnly = () =>
    setExportTracks(Object.fromEntries(allTracks.map((t) => [t.code, t.kind === 'dub'])));

  // ── Presets — map label → state deltas and jump to the right tab.
  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    setTab(p.tab);
    if (p.preserveBg !== undefined) setPreserveBg(!!p.preserveBg);
    if (p.burnSubs !== undefined) setBurnSubs(!!p.burnSubs);
    if (p.dualSubs !== undefined) setSubsDual(!!p.dualSubs);
    if (p.audioFormat) setAudioFormat(p.audioFormat);
    if (p.mp3Bitrate) setMp3Bitrate(p.mp3Bitrate);
    if (p.subsFormat) setSubsFormat(p.subsFormat);
    if (p.subsDual !== undefined) setSubsDual(!!p.subsDual);
    if (p.includeAll) setAllTracks(true);
    if (p.defaultTrack === 'dub' && dubLangCode) setDefaultTrack(dubLangCode);
  };

  // ── Filename preview — purely cosmetic, mirrors how the server names files.
  const baseName = useMemo(() => {
    const raw = (filename || 'output').replace(/\.[^.]+$/, '');
    return raw.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'output';
  }, [filename]);

  const filenamePreview = (() => {
    if (tab === 'video') return `dubbed_${baseName}_…mp4`;
    if (tab === 'audio') {
      const ext = audioFormat;
      if (audioBatch === 'each')
        return `dubbed_<lang>_${baseName}_…${ext}  (${selectedDubs.length} files)`;
      return `dubbed_${audioPrimaryLang || dubLangCode}_${baseName}_…${ext}`;
    }
    if (tab === 'subs') {
      const langs = subsBatch === 'all-dubs' ? selectedDubs.length || 1 : 1;
      const exts = subsFormat === 'both' ? 'srt+vtt' : subsFormat;
      return `subtitles${subsDual ? '_dual' : ''}.${exts}  (${langs} file${langs === 1 ? '' : 's'})`;
    }
    return 'archive.zip';
  })();

  // ── Validity: what's runnable right now?
  const canVideo = selectedTracks.length > 0 && (dubTracks || []).length > 0;
  const canAudio =
    audioBatch === 'each'
      ? selectedDubs.length > 0
      : !!audioPrimaryLang && (dubTracks || []).includes(audioPrimaryLang);
  const canSubs = segmentCount > 0 && (subsBatch !== 'all-dubs' || selectedDubs.length > 0);

  // ── Runners — fire backend calls based on tab. Each returns quickly;
  // toasts inside triggerDownload keep the user informed.
  const runVideo = () => {
    handleDubDownload?.();
    onClose?.();
  };
  const runAudio = () => {
    const langs =
      audioBatch === 'each' ? selectedDubs.map((t) => t.code) : [audioPrimaryLang || dubLangCode];
    langs.forEach((lang) => {
      if (!lang) return;
      const q = `preserve_bg=${preserveBg ? 1 : 0}&lang=${encodeURIComponent(lang)}`;
      if (audioFormat === 'wav') {
        const url = `${API}/dub/download-audio/${jobId}/dubbed_${lang}.wav?${q}`;
        handleAudioExport?.(url, `dubbed_${lang}.wav`);
      } else {
        const url = `${API}/dub/download-mp3/${jobId}/dubbed_${lang}.mp3?${q}&bitrate=${mp3Bitrate}k`;
        handleAudioExport?.(url, `dubbed_${lang}.mp3`);
      }
    });
    onClose?.();
  };
  const runSubs = () => {
    const targets = subsBatch === 'all-dubs' ? selectedDubs.map((t) => t.code) : [dubLangCode];
    const formats = subsFormat === 'both' ? ['srt', 'vtt'] : [subsFormat];
    targets.forEach((lang) => {
      formats.forEach((ext) => {
        const name = `subtitles${subsDual ? '_dual' : ''}_${lang}.${ext}`;
        // `lang` lets the backend pick fitted-timeline cue times when the
        // track was generated under Smart Fit; inert otherwise.
        const langQ = lang ? `&lang=${encodeURIComponent(lang)}` : '';
        const url = `${API}/dub/${ext}/${jobId}/${name}?dual=${subsDual ? 1 : 0}${langQ}`;
        triggerDownload?.(url, name);
      });
    });
    onClose?.();
  };
  const runStems = () => {
    handleAudioExport?.(`${API}/dub/export-stems/${jobId}`, 'stems.zip');
    onClose?.();
  };
  const runClips = () => {
    handleAudioExport?.(`${API}/dub/export-segments/${jobId}`, 'segments.zip');
    onClose?.();
  };

  const runMap = {
    video: { fn: runVideo, can: canVideo, label: t('exportModal.export_mp4') },
    audio: {
      fn: runAudio,
      can: canAudio,
      label:
        audioBatch === 'each'
          ? t('exportModal.export_n_audio', { count: selectedDubs.length })
          : t('exportModal.export_audio'),
    },
    subs: { fn: runSubs, can: canSubs, label: t('exportModal.export_subtitles') },
    pkg: { fn: null, can: false, label: t('exportModal.export') },
  };
  const active = runMap[tab];

  if (!open) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[var(--logs-footer-height,28px)] z-[90] flex justify-center"
      role="dialog"
      aria-modal="false"
      aria-label={t('exportModal.export_options')}
    >
      <div
        className="pointer-events-auto flex w-[min(880px,calc(100vw-24px))] max-h-[min(70vh,560px)] flex-col overflow-hidden rounded-t-lg border border-b-0 border-transparent bg-[var(--chrome-bg)] shadow-[0_-8px_24px_rgba(0,0,0,0.45),0_-1px_0_var(--chrome-border)_inset] animate-in fade-in slide-in-from-bottom-full duration-200"
        ref={drawerRef}
      >
        <header className="relative flex items-center gap-[var(--space-3)] p-[6px_var(--space-4)_10px] [border-bottom:1px_solid_var(--chrome-border)] [background:linear-gradient(180deg,rgba(255,255,255,0.02),transparent)]">
          <span
            className="absolute top-[4px] left-1/2 -translate-x-1/2 w-[36px] h-[3px] rounded-[2px] bg-[var(--chrome-border-strong)]"
            aria-hidden="true"
          />
          <span className="inline-flex items-center gap-[var(--space-2)]">
            <Download size={13} /> {t('exportModal.export')}
            {filename && (
              <span className="ml-[var(--space-2)] max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap [font-family:var(--chrome-font-mono)] text-[length:var(--text-sm)] text-[var(--chrome-fg-muted)]">
                · {filename}
              </span>
            )}
          </span>
          <button
            type="button"
            className="ml-auto inline-flex h-[var(--chrome-icon-btn,22px)] w-[var(--chrome-icon-btn,22px)] cursor-pointer items-center justify-center rounded-[var(--chrome-radius-pill)] bg-transparent text-[var(--chrome-fg-muted)] [border:1px_solid_transparent] transition-[background,color,border-color] duration-[var(--dur-fast)] hover:border-transparent hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--chrome-fg)]"
            onClick={onClose}
            aria-label={t('exportModal.close_drawer')}
          >
            <X size={13} />
          </button>
        </header>
        <div className="flex flex-col gap-[var(--space-4)] overflow-y-auto p-[var(--space-3)_var(--space-4)_var(--space-4)]">
          {/* Preset chips */}
          <div className="flex flex-wrap items-center gap-[var(--space-2)] pb-[var(--space-3)] [border-bottom:1px_solid_var(--chrome-border)]">
            <span className="inline-flex items-center gap-[4px] uppercase [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
              {t('exportModal.presets')}
            </span>
            {Object.entries(PRESETS).map(([k, v]) => (
              <button
                key={k}
                type="button"
                className="inline-flex cursor-pointer items-center gap-[4px] rounded-[var(--chrome-radius-pill)] bg-transparent px-[8px] py-[3px] font-sans text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] [border:1px_solid_var(--chrome-border)] transition-[background,color,border-color] duration-[var(--dur-fast)] hover:border-transparent hover:bg-[var(--chrome-hover-bg)] hover:text-[var(--chrome-fg)]"
                onClick={() => applyPreset(k)}
                title={t('exportModal.preset_title', { tab: v.tab, label: t(v.labelKey) })}
              >
                <Zap size={9} /> {t(v.labelKey)}
              </button>
            ))}
          </div>

          {/* Track checklist — shared across tabs */}
          <div className="flex flex-col gap-[var(--space-2)]">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-[4px] uppercase [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
                <Globe size={9} /> {t('exportModal.tracks')}
              </span>
              <div className="inline-flex items-center gap-[4px] text-[length:var(--text-xs)] text-[var(--chrome-fg-dim)] [&_button]:cursor-pointer [&_button]:border-none [&_button]:bg-transparent [&_button]:px-[4px] [&_button]:py-[2px] [&_button]:text-[length:var(--text-xs)] [&_button]:text-[var(--chrome-fg-muted)] [&_button:hover]:text-[var(--chrome-fg)]">
                <button type="button" onClick={() => setAllTracks(true)}>
                  {t('exportModal.track_all')}
                </button>
                <span>·</span>
                <button type="button" onClick={() => setAllTracks(false)}>
                  {t('exportModal.track_none')}
                </button>
                <span>·</span>
                <button type="button" onClick={setDubsOnly}>
                  {t('exportModal.track_dubs_only')}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-[6px]">
              {allTracks.map((track) => {
                const on = exportTracks[track.code] !== false;
                return (
                  <label key={track.code} className={trackCls(on, track.kind)}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleTrack(track.code)}
                      className="m-0 accent-[var(--color-brand)]"
                    />
                    <span className="[font-family:var(--chrome-font-mono)] tracking-[0.02em]">
                      {track.label}
                    </span>
                    {track.kind === 'dub' && track.code === dubLangCode && (
                      <Badge tone="brand" size="xs">
                        {t('exportModal.primary')}
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-[var(--space-1)] [border-bottom:1px_solid_var(--chrome-border)]">
            <button
              type="button"
              className={tabCls(tab === 'video')}
              onClick={() => setTab('video')}
            >
              <Film size={10} /> {t('exportModal.tab_video')}
            </button>
            <button
              type="button"
              className={tabCls(tab === 'audio')}
              onClick={() => setTab('audio')}
            >
              <Volume2 size={10} /> {t('exportModal.tab_audio')}
            </button>
            <button type="button" className={tabCls(tab === 'subs')} onClick={() => setTab('subs')}>
              <FileText size={10} /> {t('exportModal.tab_subs')}
            </button>
            <button type="button" className={tabCls(tab === 'pkg')} onClick={() => setTab('pkg')}>
              <Package size={10} /> {t('exportModal.tab_pkg')}
            </button>
          </div>

          {/* Tab body */}
          <div className="min-h-[160px]">
            {tab === 'video' && (
              <div className="grid grid-cols-2 gap-x-[var(--space-5)] gap-y-[var(--space-4)]">
                <Field label={t('exportModal.container')}>
                  <Segmented
                    size="sm"
                    value={videoFormat}
                    onChange={setVideoFormat}
                    items={[{ value: 'mp4', label: t('exportModal.mp4_h264') }]}
                  />
                </Field>
                <Field
                  label={t('exportModal.default_audio_track')}
                  hint={t('exportModal.default_audio_hint')}
                >
                  <select
                    className="input-base input-base--xs"
                    value={defaultTrack}
                    onChange={(e) => setDefaultTrack(e.target.value)}
                  >
                    {exportTracks['original'] !== false && (
                      <option value="original">{t('exportModal.original')}</option>
                    )}
                    {(dubTracks || [])
                      .filter((code) => exportTracks[code] !== false)
                      .map((code) => (
                        <option key={code} value={code}>
                          {code.toUpperCase()} {t('exportModal.dub_suffix')}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t('exportModal.bg_audio')}>
                  <label className={TOGGLE_CLS}>
                    <input
                      type="checkbox"
                      checked={preserveBg}
                      onChange={(e) => setPreserveBg(e.target.checked)}
                    />
                    {t('exportModal.mix_bg_video')}
                  </label>
                </Field>
                <Field label={t('exportModal.subs_in_video')}>
                  <label className={TOGGLE_CLS}>
                    <input
                      type="checkbox"
                      checked={burnSubs}
                      onChange={(e) => setBurnSubs(e.target.checked)}
                    />
                    {t('exportModal.hardsub')}
                  </label>
                  {burnSubs && (
                    <label className={TOGGLE_INDENT_CLS}>
                      <input
                        type="checkbox"
                        checked={!!dualSubs}
                        onChange={(e) => setDualSubs(e.target.checked)}
                      />
                      {t('exportModal.dual_subs_video')}
                    </label>
                  )}
                </Field>
                {(timingStrategy === 'smart_fit' || timingStrategy === 'stretch_video') && (
                  <div className="col-span-full rounded-[2px] bg-[var(--chrome-hover-bg)] p-[var(--space-2)_var(--space-3)] text-[length:var(--text-xs)] text-[var(--chrome-fg-dim)] [border-left:2px_solid_var(--chrome-border-strong)]">
                    {t('exportModal.retime_note')}
                  </div>
                )}
              </div>
            )}

            {tab === 'audio' && (
              <div className="grid grid-cols-2 gap-x-[var(--space-5)] gap-y-[var(--space-4)]">
                <Field label={t('exportModal.format')}>
                  <Segmented
                    size="sm"
                    value={audioFormat}
                    onChange={setAudioFormat}
                    items={[
                      { value: 'wav', label: t('exportModal.wav_lossless') },
                      { value: 'mp3', label: t('exportModal.mp3_compressed') },
                    ]}
                  />
                </Field>
                {audioFormat === 'mp3' && (
                  <Field label={t('exportModal.bitrate')}>
                    <Segmented
                      size="sm"
                      value={mp3Bitrate}
                      onChange={setMp3Bitrate}
                      items={[
                        { value: '128', label: '128k' },
                        { value: '192', label: '192k' },
                        { value: '256', label: '256k' },
                        { value: '320', label: '320k' },
                      ]}
                    />
                  </Field>
                )}
                <Field label={t('exportModal.what_to_export')}>
                  <Segmented
                    size="sm"
                    value={audioBatch}
                    onChange={setAudioBatch}
                    items={[
                      { value: 'each', label: t('exportModal.export_each_dub') },
                      { value: 'primary', label: t('exportModal.export_single_lang') },
                    ]}
                  />
                  {audioBatch === 'primary' && (
                    <select
                      className="input-base input-base--xs mt-[6px]"
                      value={audioPrimaryLang}
                      onChange={(e) => setAudioPrimaryLang(e.target.value)}
                    >
                      {(dubTracks || []).map((code) => (
                        <option key={code} value={code}>
                          {code.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field label={t('exportModal.bg_audio')}>
                  <label className={TOGGLE_CLS}>
                    <input
                      type="checkbox"
                      checked={preserveBg}
                      onChange={(e) => setPreserveBg(e.target.checked)}
                    />
                    {t('exportModal.mix_bg_audio')}
                  </label>
                </Field>
              </div>
            )}

            {tab === 'subs' && (
              <div className="grid grid-cols-2 gap-x-[var(--space-5)] gap-y-[var(--space-4)]">
                <Field label={t('exportModal.format')}>
                  <Segmented
                    size="sm"
                    value={subsFormat}
                    onChange={setSubsFormat}
                    items={[
                      { value: 'srt', label: 'SRT' },
                      { value: 'vtt', label: 'VTT' },
                      { value: 'both', label: t('exportModal.both') },
                    ]}
                  />
                </Field>
                <Field label={t('exportModal.layout')}>
                  <Segmented
                    size="sm"
                    value={subsDual ? 'dual' : 'single'}
                    onChange={(v) => setSubsDual(v === 'dual')}
                    items={[
                      { value: 'single', label: t('exportModal.single_line') },
                      { value: 'dual', label: t('exportModal.dual_subs') },
                    ]}
                  />
                </Field>
                <Field label={t('exportModal.languages')}>
                  <Segmented
                    size="sm"
                    value={subsBatch}
                    onChange={setSubsBatch}
                    items={[
                      {
                        value: 'target',
                        label: t('exportModal.current_target', { code: dubLangCode || '—' }),
                      },
                      {
                        value: 'all-dubs',
                        label: t('exportModal.all_selected_dubs', { count: selectedDubs.length }),
                      },
                    ]}
                  />
                </Field>
                <div className="col-span-full rounded-[2px] bg-[var(--chrome-hover-bg)] p-[var(--space-2)_var(--space-3)] text-[length:var(--text-xs)] text-[var(--chrome-fg-dim)] [border-left:2px_solid_var(--chrome-border-strong)]">
                  {t('exportModal.subs_note')}
                </div>
              </div>
            )}

            {tab === 'pkg' && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-[var(--space-3)]">
                <PkgCard
                  icon={<Package size={14} />}
                  title={t('exportModal.pkg_clips_title')}
                  body={t('exportModal.pkg_clips_body')}
                  onClick={runClips}
                  cta={t('exportModal.pkg_clips_cta')}
                />
                <PkgCard
                  icon={<Layers size={14} />}
                  title={t('exportModal.pkg_stems_title')}
                  body={t('exportModal.pkg_stems_body')}
                  onClick={runStems}
                  cta={t('exportModal.pkg_stems_cta')}
                />
                <PkgCard
                  icon={<Music size={14} />}
                  title={t('exportModal.pkg_audio_title')}
                  body={t('exportModal.pkg_audio_body', { count: (dubTracks || []).length })}
                  onClick={() => setTab('audio')}
                  cta={t('exportModal.pkg_audio_cta')}
                  ghost
                />
              </div>
            )}
          </div>

          {/* Commercial license notice */}
          <div className="flex items-center gap-[6px] p-[5px_var(--space-3)] [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-dim)] [border-top:1px_solid_var(--chrome-border)]">
            <Building2 size={11} />
            <span>
              {t('exportModal.license_text')}{' '}
              <button
                type="button"
                className="cursor-pointer p-0 text-[var(--chrome-accent)] underline underline-offset-2 [font:inherit] border-0 bg-transparent hover:text-[var(--chrome-fg)]"
                onClick={() => {
                  onClose();
                  onEnterprise?.();
                }}
              >
                {t('exportModal.license_link')}
              </button>
              .
            </span>
          </div>

          {/* Summary footer */}
          <div className="flex items-center justify-between gap-[var(--space-3)] pt-[var(--space-3)] [border-top:1px_solid_var(--chrome-border)]">
            <div className="flex min-w-0 items-center gap-[var(--space-2)]">
              <span className="inline-flex items-center gap-[4px] uppercase [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
                {t('exportModal.output')}
              </span>
              <code
                className="max-w-[340px] overflow-hidden text-ellipsis whitespace-nowrap rounded-[2px] bg-[var(--chrome-hover-bg)] px-[8px] py-[3px] [font-family:var(--chrome-font-mono)] text-[length:var(--text-xs)] text-[var(--chrome-fg)]"
                title={filenamePreview}
              >
                {filenamePreview}
              </code>
            </div>
            <div className="inline-flex gap-[var(--space-2)]">
              {tab !== 'pkg' && (
                <>
                  <Button variant="ghost" size="sm" onClick={onClose}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={active.fn}
                    disabled={!active.can}
                    leading={<Download size={11} />}
                    title={active.can ? '' : t('exportModal.nothing_selected')}
                  >
                    {active.label}
                  </Button>
                </>
              )}
              {tab === 'pkg' && (
                <Button variant="ghost" size="sm" onClick={onClose}>
                  {t('common.close')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-[6px]">
      <div className="flex flex-col gap-[2px]">
        <span className="uppercase [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] tracking-[var(--chrome-label-track)] text-[var(--chrome-fg-muted)]">
          {label}
        </span>
        {hint && (
          <span className="text-[length:var(--text-xs)] text-[var(--chrome-fg-dim)] leading-[1.4]">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function PkgCard({ icon, title, body, onClick, cta, ghost = false }) {
  return (
    <div
      className={`flex flex-col gap-[8px] rounded-[var(--chrome-radius-pill)] bg-[var(--chrome-bg)] p-[var(--space-3)] [border:1px_solid_var(--chrome-border)] ${ghost ? 'opacity-[0.75]' : ''}`}
    >
      <div className="inline-flex items-center gap-[6px] font-medium text-[length:var(--text-sm)] text-[var(--chrome-fg)]">
        {icon}
        <span>{title}</span>
      </div>
      <p className="m-0 flex-1 text-[length:var(--text-xs)] text-[var(--chrome-fg-muted)] leading-[1.4]">
        {body}
      </p>
      <Button
        variant={ghost ? 'subtle' : 'primary'}
        size="sm"
        onClick={onClick}
        leading={ghost ? null : <Check size={10} />}
      >
        {cta}
      </Button>
    </div>
  );
}
