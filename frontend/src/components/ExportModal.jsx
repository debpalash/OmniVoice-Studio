import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Film, Volume2, FileText, Package, Music, Layers, Download,
  Check, Globe, Zap, X,
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
}) {
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
    const out = [{ code: 'original', label: 'Original', kind: 'original' }];
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
    video: { fn: runVideo, can: canVideo, label: 'Export MP4' },
    audio: { fn: runAudio, can: canAudio, label: audioBatch === 'each' ? `Export ${selectedDubs.length} audio file${selectedDubs.length === 1 ? '' : 's'}` : 'Export audio' },
    subs:  { fn: runSubs,  can: canSubs,  label: 'Export subtitles' },
    pkg:   { fn: null,     can: false,    label: 'Export' },
  };
  const active = runMap[tab];

  if (!open) return null;

  return createPortal(
    <div className="export-drawer" role="dialog" aria-modal="false" aria-label="Export options">
      <div className="export-drawer__sheet" ref={drawerRef}>
        <header className="export-drawer__head">
          <span className="export-drawer__handle" aria-hidden="true" />
          <span className="export-modal__title-inner">
            <Download size={13} /> Export
            {filename && <span className="export-modal__filename">· {filename}</span>}
          </span>
          <button type="button" className="export-drawer__close" onClick={onClose} aria-label="Close export drawer">
            <X size={13} />
          </button>
        </header>
        <div className="export-modal export-modal--drawer">
        {/* Preset chips */}
        <div className="export-modal__presets">
          <span className="export-modal__kicker">PRESETS</span>
          {Object.entries(PRESETS).map(([k, v]) => (
            <button key={k} type="button" className="export-modal__preset-chip" onClick={() => applyPreset(k)} title={`Jump to ${v.tab} tab with ${v.label} defaults`}>
              <Zap size={9} /> {v.label}
            </button>
          ))}
        </div>

        {/* Track checklist — shared across tabs */}
        <div className="export-modal__tracks">
          <div className="export-modal__section-head">
            <span className="export-modal__kicker"><Globe size={9} /> TRACKS</span>
            <div className="export-modal__track-quick">
              <button type="button" onClick={() => setAllTracks(true)}>All</button>
              <span>·</span>
              <button type="button" onClick={() => setAllTracks(false)}>None</button>
              <span>·</span>
              <button type="button" onClick={setDubsOnly}>Dubs only</button>
            </div>
          </div>
          <div className="export-modal__track-row">
            {allTracks.map(t => {
              const on = exportTracks[t.code] !== false;
              return (
                <label key={t.code} className={`export-modal__track ${on ? 'is-on' : ''} ${t.kind === 'original' ? 'is-original' : 'is-dub'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggleTrack(t.code)} />
                  <span className="export-modal__track-label">{t.label}</span>
                  {t.kind === 'dub' && t.code === dubLangCode && <Badge tone="brand" size="xs">primary</Badge>}
                </label>
              );
            })}
          </div>
        </div>

        {/* Tabs */}
        <div className="export-modal__tabs">
          <button type="button" className={`export-modal__tab ${tab === 'video' ? 'is-active' : ''}`} onClick={() => setTab('video')}>
            <Film size={10} /> Video
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'audio' ? 'is-active' : ''}`} onClick={() => setTab('audio')}>
            <Volume2 size={10} /> Audio
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'subs' ? 'is-active' : ''}`} onClick={() => setTab('subs')}>
            <FileText size={10} /> Subtitles
          </button>
          <button type="button" className={`export-modal__tab ${tab === 'pkg' ? 'is-active' : ''}`} onClick={() => setTab('pkg')}>
            <Package size={10} /> Package
          </button>
        </div>

        {/* Tab body */}
        <div className="export-modal__body">
          {tab === 'video' && (
            <div className="export-modal__grid">
              <Field label="Container">
                <Segmented size="sm" value={videoFormat} onChange={setVideoFormat} items={[
                  { value: 'mp4', label: 'MP4 (H.264)' },
                ]} />
              </Field>
              <Field label="Default audio track" hint="Which audio stream plays by default when the viewer opens the file">
                <select className="input-base input-base--xs" value={defaultTrack} onChange={e => setDefaultTrack(e.target.value)}>
                  {exportTracks['original'] !== false && <option value="original">Original</option>}
                  {(dubTracks || []).filter(t => exportTracks[t] !== false).map(t => (
                    <option key={t} value={t}>{t.toUpperCase()} (Dub)</option>
                  ))}
                </select>
              </Field>
              <Field label="Background audio">
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} />
                  Mix music/FX under every dubbed track
                </label>
              </Field>
              <Field label="Subtitles in video">
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={burnSubs} onChange={e => setBurnSubs(e.target.checked)} />
                  Burn subtitles into picture (hardsub)
                </label>
                {burnSubs && (
                  <label className="export-modal__toggle export-modal__toggle--indent">
                    <input type="checkbox" checked={!!dualSubs} onChange={e => setDualSubs(e.target.checked)} />
                    Dual (translated on top of italicised original)
                  </label>
                )}
              </Field>
            </div>
          )}

          {tab === 'audio' && (
            <div className="export-modal__grid">
              <Field label="Format">
                <Segmented size="sm" value={audioFormat} onChange={setAudioFormat} items={[
                  { value: 'wav', label: 'WAV (lossless)' },
                  { value: 'mp3', label: 'MP3 (compressed)' },
                ]} />
              </Field>
              {audioFormat === 'mp3' && (
                <Field label="Bitrate">
                  <Segmented size="sm" value={mp3Bitrate} onChange={setMp3Bitrate} items={[
                    { value: '128', label: '128k' },
                    { value: '192', label: '192k' },
                    { value: '256', label: '256k' },
                    { value: '320', label: '320k' },
                  ]} />
                </Field>
              )}
              <Field label="What to export">
                <Segmented size="sm" value={audioBatch} onChange={setAudioBatch} items={[
                  { value: 'each',    label: 'Every selected dub (separate files)' },
                  { value: 'primary', label: 'Single language' },
                ]} />
                {audioBatch === 'primary' && (
                  <select className="input-base input-base--xs export-modal__mt6"
                    value={audioPrimaryLang} onChange={e => setAudioPrimaryLang(e.target.value)}>
                    {(dubTracks || []).map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Background audio">
                <label className="export-modal__toggle">
                  <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} />
                  Mix music/FX under the dubbed voice
                </label>
              </Field>
            </div>
          )}

          {tab === 'subs' && (
            <div className="export-modal__grid">
              <Field label="Format">
                <Segmented size="sm" value={subsFormat} onChange={setSubsFormat} items={[
                  { value: 'srt',  label: 'SRT' },
                  { value: 'vtt',  label: 'VTT' },
                  { value: 'both', label: 'Both' },
                ]} />
              </Field>
              <Field label="Layout">
                <Segmented size="sm" value={subsDual ? 'dual' : 'single'} onChange={v => setSubsDual(v === 'dual')} items={[
                  { value: 'single', label: 'Single line' },
                  { value: 'dual',   label: 'Dual (translated + original)' },
                ]} />
              </Field>
              <Field label="Languages">
                <Segmented size="sm" value={subsBatch} onChange={setSubsBatch} items={[
                  { value: 'target',   label: `Current target (${dubLangCode || '—'})` },
                  { value: 'all-dubs', label: `All selected dubs (${selectedDubs.length})` },
                ]} />
              </Field>
              <div className="export-modal__note">
                Subtitles are generated from segment text as-is — edit the segment table before exporting if you spotted typos.
              </div>
            </div>
          )}

          {tab === 'pkg' && (
            <div className="export-modal__pkg-grid">
              <PkgCard
                icon={<Package size={14} />} title="Per-segment clips (.zip)"
                body="Every generated segment as a numbered WAV inside a zip — good for review, voice-over post, or dataset building."
                onClick={runClips} cta="Export clips zip"
              />
              <PkgCard
                icon={<Layers size={14} />} title="Stems (.zip)"
                body="Isolated vocal track + background (music/FX) as separate WAVs. Useful for downstream audio editing."
                onClick={runStems} cta="Export stems zip"
              />
              <PkgCard
                icon={<Music size={14} />} title="Audio tracks (individual files)"
                body={`Jump to the Audio tab to export per-language dubs in WAV or MP3 (${(dubTracks || []).length} dub${(dubTracks || []).length === 1 ? '' : 's'} available).`}
                onClick={() => setTab('audio')} cta="Open audio tab"
                ghost
              />
            </div>
          )}
        </div>

        {/* Summary footer */}
        <div className="export-modal__summary">
          <div className="export-modal__summary-left">
            <span className="export-modal__kicker">OUTPUT</span>
            <code className="export-modal__summary-name" title={filenamePreview}>{filenamePreview}</code>
          </div>
          <div className="export-modal__summary-right">
            {tab !== 'pkg' && (
              <>
                <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
                <Button
                  variant="primary" size="sm"
                  onClick={active.fn} disabled={!active.can}
                  leading={<Download size={11} />}
                  title={active.can ? '' : 'Nothing selected or track unavailable'}
                >
                  {active.label}
                </Button>
              </>
            )}
            {tab === 'pkg' && (
              <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
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
