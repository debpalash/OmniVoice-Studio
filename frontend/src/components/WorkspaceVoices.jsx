/**
 * WorkspaceVoices — the right-side "Saved voices" panel.
 *
 * Relocates the saved-profile list that used to live in the left Sidebar
 * (the "Designed voices" / "Voice clones" section) to the right column, so
 * the Voice workspace can dissolve the left sidebar entirely. Profiles are
 * scoped by define-method: clone mode shows reference-audio profiles
 * (no instruct), design mode shows designed profiles (have instruct).
 *
 * Card markup + actions mirror the former Sidebar section 1:1 (select,
 * preview, open full profile, try-voice, unlock, delete) so behavior is
 * unchanged — only the location moves.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, Fingerprint, Wand2, Lock, Unlock, Play, Loader, Check, Volume2, Trash2,
} from 'lucide-react';
import './WorkspaceVoices.css';

export default function WorkspaceVoices({
  mode,
  profiles = [],
  selectedProfile,
  previewLoading,
  handleSelectProfile,
  handleDeleteProfile,
  handlePreviewVoice,
  handleUnlockProfile,
  openVoiceProfile,
  onOpenVoicePreview,
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const qLower = q.trim().toLowerCase();

  const items = useMemo(() => {
    const byMode = profiles.filter(p => (mode === 'clone' ? !p.instruct : !!p.instruct));
    if (!qLower) return byMode;
    return byMode.filter(p =>
      (p.name || '').toLowerCase().includes(qLower) ||
      (p.instruct || '').toLowerCase().includes(qLower)
    );
  }, [profiles, mode, qLower]);

  const title = mode === 'clone' ? t('sidebar.voice_clones') : t('sidebar.designed_voices');

  return (
    <section className={`wv ${items.length === 0 ? 'wv--collapsed' : ''}`}>
      <div className="wv__head">
        <span className="wv__title">{title}</span>
        <div className="wv__search">
          <Search size={12} className="wv__search-icon" />
          <input
            className="input-base wv__search-input"
            placeholder={t('sidebar.search', { defaultValue: 'Search…' })}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="wv__scroll">
        {items.length === 0 ? (
          <div className="wv__empty">
            {mode === 'clone'
              ? t('sidebar.no_clones', { defaultValue: 'No voice clones yet' })
              : t('sidebar.no_designs', { defaultValue: 'No designed voices yet' })}
          </div>
        ) : items.map(proj => {
          const accent = proj.is_locked ? '#b8bb26' : (mode === 'clone' ? '#d3869b' : '#8ec07c');
          const KindIcon = proj.is_locked ? Lock : (mode === 'clone' ? Fingerprint : Wand2);
          return (
            <div
              key={proj.id}
              className={`history-item ${selectedProfile === proj.id ? 'project-active' : ''}`}
              style={{ '--row-accent': accent }}
              onClick={() => handleSelectProfile(proj)}
            >
              <div className="history-row-head">
                <span className="history-kind" style={{ color: accent, borderColor: `${accent}40` }}>
                  <KindIcon size={9} /> {proj.is_locked ? t('sidebar.locked') : (mode === 'clone' ? t('sidebar.clone_label') : t('sidebar.design_label'))}
                </span>
                {proj.is_locked ? <span className="history-meta history-meta--locked">{t('sidebar.consistent')}</span> : null}
              </div>
              <div className="history-title">{proj.name}</div>
              {proj.instruct ? <div className="history-subtitle history-subtitle--italic">{proj.instruct}</div> : null}

              <div className="history-actions">
                <button className="history-action-btn history-action-icon" onClick={(e) => { e.stopPropagation(); handlePreviewVoice(proj, e); }} title="Preview">
                  {previewLoading === proj.id ? <Loader className="spinner" size={10} /> : <Play size={10} />}
                </button>
                {openVoiceProfile && (
                  <button className="history-action-btn" onClick={(e) => { e.stopPropagation(); openVoiceProfile(proj.id); }} title="Open full profile">
                    {t('sidebar.open')}
                  </button>
                )}
                <button className="history-action-btn" onClick={(e) => { e.stopPropagation(); handleSelectProfile(proj); }}>
                  <Check size={10} /> {t('sidebar.select')}
                </button>
                {onOpenVoicePreview && (
                  <button className="history-action-btn accent" onClick={(e) => { e.stopPropagation(); onOpenVoicePreview(proj.id); }} title="Open interactive voice preview">
                    <Volume2 size={10} /> {t('sidebar.try_voice')}
                  </button>
                )}
                {proj.is_locked ? (
                  <button className="history-action-btn accent history-action-icon" onClick={(e) => { e.stopPropagation(); handleUnlockProfile(proj.id); }} title="Unlock">
                    <Unlock size={10} />
                  </button>
                ) : null}
                <button className="history-action-btn danger history-action-icon" onClick={(e) => { e.stopPropagation(); handleDeleteProfile(proj.id); }} title="Delete">
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
