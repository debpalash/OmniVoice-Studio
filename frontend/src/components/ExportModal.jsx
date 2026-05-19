import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation, Trans } from 'react-i18next';
import {
  Film, Volume2, FileText, Package, Music, Layers, Download,
  Check, Globe, Zap, X, Building2,
} from 'lucide-react';
import { Button, Segmented, Badge } from '../ui';
import './ExportModal.css';

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
  youtube:  { label: 'YouTube',  tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: false, defaultTrack: 'dub' },
  archive:  { label: 'Archive',  tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: false, includeAll: true },
  web:      { label: 'Web',      tab: 'video', format: 'mp4', preserveBg: true,  burnSubs: true,  dualSubs: false },
  podcast:  { label: 'Podcast',  tab: 'audio', audioFormat: 'mp3', mp3Bitrate: '192', preserveBg: false },
  studyset: { label: 'Study set',tab: 'subs',  subsFormat: 'srt', subsDual: true },
};

export default function ExportModal({
  open, onClose,
  jobId, filename, dubTracks, dubLangCode,
  preserveBg, setPreserveBg,
  defaultTrack, setDefaultTrack,
  exportTracks, setExportTracks,
  dualSubs, setDualSubs,
  burnSubs, setBurnSubs,
  API,
  triggerDownload,
  handleDubDownload, handleDubAudioDownload, handleAudioExport,
  segmentCount = 0,
  onEnterprise,
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState('video');

  // ── Tab-local state (not persisted across sessions — each open is fresh).
  const [videoFormat, setVideoFormat] = useState('mp4');   // future: webm/mov
  const [audioFormat, setAudioFormat] = useState('wav');   // wav | mp3
  const [mp3Bitrate, setMp3Bitrate] = useState('192');     // 128/192/256/320
  const [audioBatch, setAudioBatch] = useState('each');    // each | primary — per-lang or single file
  const [audioPrimaryLang, setAudioPrimaryLang] = useState(dubLangCode || '');
  const [subsFormat, setSubsFormat] = useState('srt');     // srt | vtt | both
  const [subsDual, setSubsDual] = useState(!!dualSubs);
  const [subsBatch, setSubsBatch] = useState('target');    // target | all-dubs

  // Reflect the parent's dual/burn once, then own them locally so the modal
  // can toy with them without committing on cancel.
  useEffect(() => { setSubsDual(!!dualSubs); }, [open, dualSubs]);

  // ── Drawer dismiss — ESC closes; click-outside closes. The drawer is a
  // bottom sheet (non-blocking), so background interactions stay live.
  const drawerRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
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
    const out = [{ code: 'original', label: t('dub.original'), kind: 'original' }];
    (dubTracks || []).forEach(t => out.push({ code: t, label: t.toUpperCase(), kind: 'dub' }));
    return out;
  }, [dubTracks]);

  const dubOnlyTracks = useMemo(() => allTracks.filter(t => t.kind === 'dub'), [allTracks]);
  const selectedTracks = allTracks.filter(t => exportTracks[t.code] !== false);
  const selectedDubs = selectedTracks.filter(t => t.kind === 'dub');

  const toggleTrack = (code) => setExportTracks(prev => ({ ...prev, [code]: prev[code] === false ? true : false }));
  const setAllTracks = (on) => setExportTracks(Object.fromEntries(allTracks.map(t => [t.code, on])));
  const setDubsOnly  = () => setExportTracks(Object.fromEntries(allTracks.map(t => [t.code, t.kind === 'dub'])));

  // ── Presets — map label → state deltas and jump to the right tab.
  const applyPreset = (key) => {
    const p = PRESETS[key];
    if (!p) return;
    setTab(p.tab);
    if (p.preserveBg !== undefined) setPreserveBg(!!p.preserveBg);
    if (p.burnSubs   !== undefined) setBurnSubs(!!p.burnSubs);
    if (p.dualSubs   !== undefined) setSubsDual(!!p.dualSubs);
    if (p.audioFormat) setAudioFormat(p.audioFormat);
    if (p.mp3Bitrate)  setMp3Bitrate(p.mp3Bitrate);
    if (p.subsFormat)  setSubsFormat(p.subsFormat);
    if (p.subsDual !== undefined) setSubsDual(!!p.subsDual);
    if (p.includeAll)  setAllTracks(true);
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
      if (audioBatch === 'each') return `dubbed_<lang>_${baseName}_…${ext}  (${selectedDubs.length} files)`;
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
  const canAudio = audioBatch === 'each'
    ? selectedDubs.length > 0
    : !!audioPrimaryLang && (dubTracks || []).includes(audioPrimaryLang);
  const canSubs  = segmentCount > 0 && (subsBatch !== 'all-dubs' || selectedDubs.length > 0);

  // ── Runners — fire backend calls based on tab. Each returns quickly;
  // toasts inside triggerDownload keep the user informed.
  const runVideo = () => {
    handleDubDownload?.();
    onClose?.();
  };
  const runAudio = () => {
    const langs = audioBatch === 'each'
      ? selectedDubs.map(t => t.code)
      : [audioPrimaryLang || dubLangCode];
    langs.forEach(lang => {
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
    const targets = subsBatch === 'all-dubs' ? selectedDubs.map(t => t.code) : [dubLangCode];
    const formats = subsFormat === 'both' ? ['srt', 'vtt'] : [subsFormat];
    targets.forEach(lang => {
      formats.forEach(ext => {
        const name = `subtitles${subsDual ? '_dual' : ''}_${lang}.${ext}`;
        const url = `${API}/dub/${ext}/${jobId}/${name}?dual=${subsDual ? 1 : 0}`;
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
    video: { fn: runVideo, can: canVideo, label: t('dub.export_mp4_cta') },
    audio: { fn: runAudio, can: canAudio, label: audioBatch === 'each' ? (selectedDubs.length === 1 ? t('dub.export_audio_files_cta_one', { n: selectedDubs.length }) : t('dub.export_audio_files_cta_other', { n: selectedDubs.length })) : t('dub.export_audio_cta') },
    subs:  { fn: runSubs,  can: canSubs,  label: t('dub.export_subtitles_cta') },
    pkg:   { fn: null,     can: false,    label: t('common.export') },
  };
  const active = runMap[tab];

  if (!open) return null;

  return createPortal(
    <div className="export-drawer" role="dialog" aria-modal="false" aria-label={t('dub.export_options')}>
      <div className="export-drawer__sheet" ref={drawerRef}>
        <header className="export-drawer__head">
          <span className="export-drawer__handle" aria-hidden="true" />
          <span className="export-modal__title-inner">
            <Download size={13} /> {t('dub.export_modal_title')}
            {filename && <span className="export-modal__filename">· {filename}</span>}
          </span>
          <button type="button" className="export-drawer__close" onClick={onClose} aria-label={t('dub.export_close_drawer')}>
            <X size={13} />
          </button>
        </header>
        <div className="export-modal export-modal--drawer">
        {/* Preset chips */}
        <div className="export-modal__presets">
          <span className="export-modal__kicker">{t('dub.export_presets')}</span>
          {Object.entries(PRESETS).map(([k, v]) => {
            const presetLabel = t(`dub.export_preset_${k}`);
            const tabKeyMap = { video: 'dub.export_video_tab', audio: 'dub.export_audio_tab', subs: 'dub.export_subtitles_tab' };
            const tabLabel = t(tabKeyMap[v.tab] || 'dub.export_video_tab');
            return (
              <button key={k} type="button" className="export-modal__preset-chip" onClick={() => applyPreset(k)} title={t('dub.export_jump_preset', { tab: tabLabel, label: presetLabel })}>
                <Zap size={9} /> {presetLabel}
              </button>
            );
          })}
        </div>

        {/* Track checklist — shared across tabs */}
        <div className="export-modal__tracks">
          <div className="export-modal__section-head">
            <span className="export-modal__kicker"><Globe size={9} /> {t('dub.export_tracks_section')}</span>
            <div className="export-modal__track-quick">
              <button type="button" onClick={() => setAllTracks(true)}>{t('common.all')}</button>
              <span>·</span>
              <button type="button" onClick={() => setAllTracks(false)}>{t('common.none')}</button>
              <span>·</span>
              <button type="button" onClick={setDubsOnly}>{t('dub.export_dubs_only')}</button>
            </div>
          </div>
          <div className="export-modal__track-row">
            {allTracks.map(trk => {
              const on = exportTracks[trk.code] !== false;
              return (
                <label key={trk.code} className={`export-modal__track ${on ? 'is-on' : ''} ${trk.kind === 'original' ? 'is-original' : 'is-dub'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleTrack(trk.code)} />
                  <span className="export-modal__track-label">{trk.label}</span>
                  {trk.kind === 'dub' && trk.code === dubLangCode && <Badge tone="brand" size="xs">{t('dub.export_primary')}</Badge>}
                </label>
              );
            })}
          </div>
        </div>

        {/* Tabs */}
        <div className="export-modal__tabs">
          <button type="button" className={`export-modal__tab ${tab === 'video' ? 'is-active' : ''}`} onClick={() => setTab('video')}>
            <Film size={10} /> {t('dub.export_video_tab')}
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'audio' ? 'is-active' : ''}`} onClick={() => setTab('audio')}>
            <Volume2 size={10} /> {t('dub.export_audio_tab')}
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'subs' ? 'is-active' : ''}`} onClick={() => setTab('subs')}>
            <FileText size={10} /> {t('dub.export_subtitles_tab')}
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'pkg' ? 'is-active' : ''}`} onClick={() => setTab('pkg')}>
            <Package size={10} /> {t('dub.export_package_tab')}
          </button>
        </div>

        {/* Tab body */}
        <div className="export-modal__body">
          {tab === 'video' && (
            <div className="export-modal__grid">
              <Field label={t('dub.export_container')}>
                <Segmented size="sm" value={videoFormat} onChange={setVideoFormat} items={[
                  { value: 'mp4', label: t('dub.export_mp4_h264') },
                ]} />
              </Field>
              <Field label={t('dub.export_default_audio_track')} hint={t('dub.export_default_audio_hint')}>
                <select className="input-base input-base--xs" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
                  {exportTracks['original'] !== false && <option value="original">{t('dub.original')}</option>}
                  {(dubTracks || []).filter(code => exportTracks[code] !== false).map(code => (
                    <option key={code} value={code}>{t('dub.dub_track', { code: code.toUpperCase() })}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('dub.export_background_audio')}>
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} />
                  {t('dub.export_mix_music_fx')}
                </label>
              </Field>
              <Field label={t('dub.export_subtitles_in_video')}>
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={burnSubs} onChange={e => setBurnSubs(e.target.checked)} />
                  {t('dub.export_burn_subtitles')}
                </label>
                {burnSubs && (
                  <label className="export-modal__toggle export-modal__toggle--indent">
                    <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} />
                    {t('dub.export_dual_subtitles')}
                  </label>
                )}
              </Field>
            </div>
          )}

          {tab === 'audio' && (
            <div className="export-modal__grid">
              <Field label={t('dub.export_format')}>
                <Segmented size="sm" value={audioFormat} onChange={setAudioFormat} items={[
                  { value: 'wav', label: t('dub.export_wav_lossless') },
                  { value: 'mp3', label: t('dub.export_mp3_compressed') },
                ]} />
              </Field>
              {audioFormat === 'mp3' && (
                <Field label={t('dub.export_bitrate')}>
                  <Segmented size="sm" value={mp3Bitrate} onChange={setMp3Bitrate} items={[
                    { value: '128', label: '128k' },
                    { value: '192', label: '192k' },
                    { value: '256', label: '256k' },
                    { value: '320', label: '320k' },
                  ]} />
                </Field>
              )}
              <Field label={t('dub.export_what_to_export')}>
                <Segmented size="sm" value={audioBatch} onChange={setAudioBatch} items={[
                  { value: 'each',    label: t('dub.export_every_dub') },
                  { value: 'primary', label: t('dub.export_single_language') },
                ]} />
                {audioBatch === 'primary' && (
                  <select className="input-base input-base--xs export-modal__mt6"
                    value={audioPrimaryLang} onChange={e => setAudioPrimaryLang(e.target.value)}>
                    {(dubTracks || []).map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                  </select>
                )}
              </Field>
              <Field label={t('dub.export_background_audio')}>
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} />
                  {t('dub.export_mix_music_dub')}
                </label>
              </Field>
            </div>
          )}

          {tab === 'subs' && (
            <div className="export-modal__grid">
              <Field label={t('dub.export_format')}>
                <Segmented size="sm" value={subsFormat} onChange={setSubsFormat} items={[
                  { value: 'srt',  label: t('dub.export_srt_format') },
                  { value: 'vtt',  label: t('dub.export_vtt_format') },
                  { value: 'both', label: t('dub.export_both_format') },
                ]} />
              </Field>
              <Field label={t('dub.export_layout')}>
                <Segmented size="sm" value={subsDual ? 'dual' : 'single'} onChange={v => setSubsDual(v === 'dual')} items={[
                  { value: 'single', label: t('dub.export_single_line') },
                  { value: 'dual',   label: t('dub.export_dual_layout') },
                ]} />
              </Field>
              <Field label={t('dub.export_languages')}>
                <Segmented size="sm" value={subsBatch} onChange={setSubsBatch} items={[
                  { value: 'target',   label: t('dub.export_current_target', { code: dubLangCode || '—' }) },
                  { value: 'all-dubs', label: t('dub.export_all_selected_dubs', { n: selectedDubs.length }) },
                ]} />
              </Field>
              <div className="export-modal__note">
                {t('dub.export_subtitles_note')}
              </div>
            </div>
          )}

          {tab === 'pkg' && (
            <div className="export-modal__pkg-grid">
              <PkgCard
                icon={<Package size={14} />} title={t('dub.export_clips_zip')}
                body={t('dub.export_clips_desc')}
                onClick={runClips} cta={t('dub.export_clips_cta')}
              />
              <PkgCard
                icon={<Layers size={14} />} title={t('dub.export_stems_zip')}
                body={t('dub.export_stems_desc')}
                onClick={runStems} cta={t('dub.export_stems_cta')}
              />
              <PkgCard
                icon={<Music size={14} />} title={t('dub.export_audio_tracks')}
                body={t('dub.export_audio_tracks_desc')}
                onClick={() => setTab('audio')} cta={t('dub.export_open_audio_tab')}
                ghost
              />
            </div>
          )}
        </div>

        {/* Commercial license notice */}
        <div className="export-modal__license-notice">
          <Building2 size={11} />
          <span><Trans i18nKey="dub.export_commercial_notice" components={{ 1: <button type="button" className="export-modal__license-link" onClick={() => { onClose(); onEnterprise?.(); }} /> }} /></span>
        </div>

        {/* Summary footer */}
        <div className="export-modal__summary">
          <div className="export-modal__summary-left">
            <span className="export-modal__kicker">{t('dub.export_output_section')}</span>
            <code className="export-modal__summary-name" title={filenamePreview}>{filenamePreview}</code>
          </div>
          <div className="export-modal__summary-right">
            {tab !== 'pkg' && (
              <>
                <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
                <Button
                  variant="primary" size="sm"
                  onClick={active.fn} disabled={!active.can}
                  leading={<Download size={11} />}
                  title={active.can ? '' : t('dub.export_nothing_selected')}
                >
                  {active.label}
                </Button>
              </>
            )}
            {tab === 'pkg' && (
              <Button variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
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
    <div className="export-modal__field">
      <div className="export-modal__field-head">
        <span className="export-modal__field-label">{label}</span>
        {hint && <span className="export-modal__field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function PkgCard({ icon, title, body, onClick, cta, ghost = false }) {
  return (
    <div className={`export-modal__pkg-card ${ghost ? 'is-ghost' : ''}`}>
      <div className="export-modal__pkg-head">{icon}<span>{title}</span></div>
      <p className="export-modal__pkg-body">{body}</p>
      <Button variant={ghost ? 'subtle' : 'primary'} size="sm" onClick={onClick} leading={ghost ? null : <Check size={10} />}>
        {cta}
      </Button>
    </div>
  );
}
