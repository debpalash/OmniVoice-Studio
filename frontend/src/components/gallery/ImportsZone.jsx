import React, { useState, useRef } from 'react';
import {
  Search, Download, Play, Pause, Trash2, X, Loader, UserPlus, Upload, Scissors, Package,
} from 'lucide-react';
import { Button, Input } from '../../ui';
import { useGalleryVoices } from '../../api/hooks';
import { importPersona } from '../../api/profiles';
import {
  searchYoutube, downloadYoutubeClip, deleteGalleryVoice,
  saveVoiceAsProfile, uploadVoiceClip, previewVoiceUrl,
} from '../../api/gallery';
import AudioTrimmer from '../AudioTrimmer';
import { apiFetch } from '../../api/client';
import { askConfirm } from '../../utils/dialog';

// ── My Imports zone (neutral importer) ───────────────────────────────────────
export default function ImportsZone({ t, playingId, loadingPreviewId, onPlayGallery, flash }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [trimming, setTrimming] = useState(null); // { voice, file }
  const fileRef = useRef(null);
  const personaRef = useRef(null);
  const [importingPersona, setImportingPersona] = useState(false);

  const voicesQ = useGalleryVoices();
  const voices = voicesQ.data || [];
  const reload = () => voicesQ.refetch();

  // Import a portable .ovsvoice (or legacy .omnivoice) persona bundle (#29).
  const handlePersonaImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingPersona(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await importPersona(fd);
      reload();
      flash(t('gallery.persona_imported', {
        defaultValue: 'Imported "{{name}}"{{unverified}}.', name: res.name,
        unverified: res.verified_own_voice ? '' : t('gallery.persona_unverified_suffix', { defaultValue: ' (unverified)' }),
      }));
    } catch (err) {
      const code = String(err?.message || err);
      const msg = code.includes('413')
        ? t('gallery.persona_too_large', { defaultValue: 'That bundle is too large (max 100 MB).' })
        : t('gallery.persona_import_failed', { defaultValue: 'Could not import that persona bundle.' });
      flash(msg);
    } finally {
      setImportingPersona(false);
      if (personaRef.current) personaRef.current.value = '';
    }
  };

  const isUrl = /^https?:\/\//i.test(query.trim());

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;
    if (isUrl) {
      setIsDownloading(true);
      try {
        await downloadYoutubeClip({
          video_url: q, start_time: 0, duration: 15,
          character_name: t('gallery.imported_clip', { defaultValue: 'Imported clip' }),
          category: 'import', description: q,
        });
        reload();
        setQuery('');
      } catch (e) {
        flash(t('gallery.download_failed', { defaultValue: 'Download failed: {{msg}}', msg: e.message }));
      } finally {
        setIsDownloading(false);
      }
      return;
    }
    setIsSearching(true);
    try {
      const r = await searchYoutube(q, 'import', 10);
      setResults(r.results || []);
    } catch (e) {
      flash(t('gallery.search_failed', { defaultValue: 'Search failed.' }));
    } finally {
      setIsSearching(false);
    }
  };

  const handleDownload = async (info) => {
    setIsDownloading(true);
    try {
      await downloadYoutubeClip({
        video_url: `https://youtube.com/watch?v=${info.video_id}`,
        start_time: 0,
        duration: Math.min(parseFloat(info.duration) || 15, 30),
        character_name: (info.title || '').substring(0, 40),
        category: 'import',
        description: info.title,
      });
      reload();
      setResults([]);
    } catch (e) {
      flash(t('gallery.download_failed', { defaultValue: 'Download failed: {{msg}}', msg: e.message }));
    } finally {
      setIsDownloading(false);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('name', file.name.replace(/\.[^.]+$/, ''));
    fd.append('category', 'import');
    fd.append('audio', file);
    try {
      await uploadVoiceClip(fd);
      reload();
    } catch (err) {
      flash(t('gallery.upload_failed', { defaultValue: 'Upload failed.' }));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSaveProfile = async (v) => {
    try {
      await saveVoiceAsProfile(v.id, v.name);
      flash(t('gallery.saved_as_profile', { defaultValue: 'Added "{{name}}" to your voices.', name: v.name }));
    } catch (e) {
      flash(t('gallery.save_failed', { defaultValue: 'Could not save profile.' }));
    }
  };

  const handleDelete = async (v) => {
    if (!(await askConfirm(t('gallery.confirm_delete', { defaultValue: 'Delete "{{name}}"?', name: v.name })))) return;
    try { await deleteGalleryVoice(v.id); reload(); } catch { /* noop */ }
  };

  const handleTrimClick = async (v) => {
    try {
      const resp = await apiFetch(previewVoiceUrl(v.id));
      const blob = await resp.blob();
      const file = new File([blob], `${v.name}.wav`, { type: 'audio/wav' });
      setTrimming({ voice: v, file });
    } catch (e) {
      flash(t('gallery.trim_load_failed', { defaultValue: 'Could not load audio for trimming.' }));
    }
  };

  const handleConfirmTrim = async (trimmedFile) => {
    if (!trimming) return;
    const { voice } = trimming;
    const fd = new FormData();
    fd.append('name', `${voice.name} (Cropped)`);
    fd.append('character', voice.character || '');
    fd.append('category', 'import');
    fd.append('description', voice.description || '');
    fd.append('audio', trimmedFile);
    try { await uploadVoiceClip(fd); reload(); setTrimming(null); } catch (e) {
      flash(t('gallery.upload_failed', { defaultValue: 'Upload failed.' }));
    }
  };

  return (
    <div className="gallery-content">
      <div className="import-explainer">
        {t('gallery.import_explainer', {
          defaultValue: 'Paste a URL you have the rights to (or upload a file), trim the part you need, and save it as a voice. You are responsible for the licensing of anything you import.',
        })}
      </div>

      <div className="gallery-search">
        <div className="search-row">
          <Input
            placeholder={t('gallery.import_placeholder', { defaultValue: 'Paste a video/audio URL, or type to search…' })}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          />
          <Button onClick={handleSearch} disabled={isSearching || isDownloading} size="sm">
            {isSearching || isDownloading ? <Loader size={14} className="spin" /> : isUrl ? <Download size={14} /> : <Search size={14} />}
          </Button>
          <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={handleUpload} />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} title={t('gallery.upload', { defaultValue: 'Upload file' })}>
            <Upload size={14} />
          </Button>
          <input ref={personaRef} type="file" accept=".ovsvoice,.omnivoice" hidden onChange={handlePersonaImport} />
          <Button variant="ghost" size="sm" disabled={importingPersona}
            onClick={() => personaRef.current?.click()}
            title={t('gallery.import_persona', { defaultValue: 'Import a .ovsvoice persona bundle' })}>
            {importingPersona ? <Loader size={14} className="spin" /> : <Package size={14} />}
          </Button>
        </div>
      </div>

      {results.length > 0 && (
        <div className="search-results-panel">
          <div className="panel-header">
            <span>{t('gallery.search_results', { defaultValue: '{{count}} results', count: results.length })}</span>
            <button className="close-btn" onClick={() => setResults([])}><X size={14} /></button>
          </div>
          <div className="results-list">
            {results.map((r, i) => (
              <div key={i} className="result-row">
                <div className="result-info">
                  <span className="result-title">{r.title}</span>
                  <span className="result-meta">{r.duration || '?'}s</span>
                </div>
                <Button size="sm" onClick={() => handleDownload(r)} disabled={isDownloading}>
                  <Download size={12} /> {t('gallery.import', { defaultValue: 'Import' })}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="content-header">
        <div className="content-title">
          {t('gallery.my_imports', { defaultValue: 'My Imports' })}<span className="count-badge">{voices.length}</span>
        </div>
      </div>

      {voicesQ.isLoading ? (
        <div className="loading"><Loader className="spin" size={18} /></div>
      ) : voices.length === 0 ? (
        <div className="empty">{t('gallery.no_imports', { defaultValue: 'Nothing imported yet. Paste a URL above to get started.' })}</div>
      ) : (
        <div className="voice-list">
          {voices.map((v) => (
            <div key={v.id} className="voice-card">
              <button className="voice-play" onClick={() => onPlayGallery(v)}>
                {loadingPreviewId === v.id ? <Loader className="spin" size={16} /> : playingId === v.id ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <div className="voice-info">
                <span className="voice-name">{v.name}</span>
                <span className="voice-meta">{Math.round(v.duration || 0)}s</span>
              </div>
              <div className="voice-actions">
                <button className="action-btn" onClick={() => handleTrimClick(v)} title={t('gallery.trim', { defaultValue: 'Trim' })}><Scissors size={14} /></button>
                <button className="action-btn" onClick={() => handleSaveProfile(v)} title={t('gallery.use_voice', { defaultValue: 'Use voice' })}><UserPlus size={14} /></button>
                <button className="action-btn danger" onClick={() => handleDelete(v)} title={t('gallery.delete', { defaultValue: 'Delete' })}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {trimming && (
        <AudioTrimmer
          file={trimming.file}
          maxSeconds={60}
          onConfirm={handleConfirmTrim}
          onCancel={() => setTrimming(null)}
        />
      )}
    </div>
  );
}
