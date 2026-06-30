/**
 * WorkspaceVoices — the right-side "Saved voices" panel.
 *
 * Relocates the saved-profile list that used to live in the left Sidebar
 * (the "Designed voices" / "Voice clones" section) to the right column, so
 * the Voice workspace can dissolve the left sidebar entirely. Profiles are
 * scoped by define-method: 'audio' shows reference-audio profiles
 * (no instruct), 'design' shows designed profiles (have instruct).
 *
 * Card markup + actions mirror the former Sidebar section 1:1 (select,
 * preview, open full profile, try-voice, unlock, delete) so behavior is
 * unchanged — only the location moves.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search,
  Fingerprint,
  Wand2,
  Lock,
  Unlock,
  Play,
  Loader,
  Check,
  Volume2,
  Trash2,
  Plus,
} from 'lucide-react';
import WaveformPlayer from './WaveformPlayer';
import { API } from '../api/client';
import { useAppStore } from '../store';
import './WorkspaceVoices.css';

export default function WorkspaceVoices({
  defineMethod,
  profiles = [],
  selectedProfile,
  setSelectedProfile,
  previewLoading,
  handleSelectProfile,
  handleDeleteProfile,
  handlePreviewVoice,
  handleUnlockProfile,
  openVoiceProfile,
  onOpenVoicePreview,
}) {
  const { t } = useTranslation();
  const setDefineMethod = useAppStore((s) => s.setDefineMethod);
  const [q, setQ] = useState('');
  const qLower = q.trim().toLowerCase();

  // ACTIVE VOICE card (10x §2): always answer "who speaks when I press
  // Synthesize". Recipe = instruct (designed) or "your reference clip".
  const active = profiles.find((p) => p.id === selectedProfile) || null;

  const items = useMemo(() => {
    const byMethod = profiles.filter((p) =>
      defineMethod === 'audio' ? !p.instruct : !!p.instruct,
    );
    if (!qLower) return byMethod;
    return byMethod.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(qLower) ||
        (p.instruct || '').toLowerCase().includes(qLower),
    );
  }, [profiles, defineMethod, qLower]);

  const title = defineMethod === 'audio' ? t('sidebar.voice_clones') : t('sidebar.designed_voices');

  return (
    <section className={`wv ${items.length === 0 ? 'wv--collapsed' : ''}`}>
      {/* ── ACTIVE VOICE ─────────────────────────────────────────────── */}
      <div className="flex-[0_0_auto] py-[10px] px-[12px] border-b border-solid border-b-[var(--chrome-border)]">
        <div className="[font-family:var(--chrome-font-mono,var(--font-mono))] text-[0.62rem] uppercase [letter-spacing:0.06em] text-[color:var(--chrome-fg-muted,#a89984)] mb-[6px]">
          {t('voices.active', { defaultValue: 'Active voice' })}
        </div>
        {active ? (
          <div className="flex flex-col gap-[6px] py-[8px] px-[10px] border border-solid border-[var(--chrome-accent-border,rgba(211,134,155,0.35))] bg-[var(--chrome-accent-bg,rgba(211,134,155,0.08))] rounded-[10px]">
            <div className="flex items-center gap-[8px] justify-between">
              <span className="text-[0.8rem] font-semibold text-[color:var(--chrome-fg)] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                {active.name}
              </span>
              <span
                className="history-kind"
                style={{
                  color: active.instruct ? '#8ec07c' : '#d3869b',
                  borderColor: active.instruct ? '#8ec07c40' : '#d3869b40',
                }}
              >
                {active.instruct ? t('sidebar.design_label') : t('sidebar.clone_label')}
              </span>
            </div>
            <div className="text-[0.68rem] text-[color:var(--chrome-fg-muted)] whitespace-nowrap overflow-hidden text-ellipsis">
              {active.instruct ||
                t('voices.active_clone_recipe', {
                  defaultValue: 'Cloned from your reference clip',
                })}
            </div>
            {active.ref_audio_path ? (
              <WaveformPlayer
                src={`${API}/profiles/${active.id}/audio`}
                source="profile-sample"
                height={26}
                compact
              />
            ) : null}
            <div className="flex gap-[6px]">
              <button
                type="button"
                className="history-action-btn"
                onClick={() => setSelectedProfile?.(null)}
              >
                <Plus size={10} /> {t('voices.new', { defaultValue: 'New voice' })}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-[0.7rem] [line-height:1.5] text-[color:var(--chrome-fg-muted)] py-[8px] px-[10px] border border-dashed border-[var(--chrome-border)] rounded-[10px]">
            {t('voices.none_selected', {
              defaultValue: 'No voice selected — describe one, drop audio, or pick below.',
            })}
          </div>
        )}
      </div>

      <div className="wv__head">
        <span className="wv__title">{title}</span>
        <div className="wv__search">
          <Search size={12} className="wv__search-icon" />
          <input
            className="input-base wv__search-input"
            placeholder={t('sidebar.search', { defaultValue: 'Search…' })}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="wv__scroll">
        {items.length === 0 ? (
          <div className="wv__empty">
            {defineMethod === 'audio'
              ? t('sidebar.no_clones', { defaultValue: 'No voice clones yet' })
              : t('sidebar.no_designs', { defaultValue: 'No designed voices yet' })}
            {/* Empty states carry verbs (10x §2). */}
            <button
              type="button"
              className="block mt-[8px] mx-auto py-[4px] px-[10px] text-[0.66rem] text-[color:var(--chrome-fg-muted)] bg-transparent border border-dashed border-[var(--chrome-border)] rounded-[var(--chrome-radius-pill,999px)] cursor-default"
              onClick={() => setDefineMethod(defineMethod === 'audio' ? 'audio' : 'design')}
            >
              {defineMethod === 'audio'
                ? t('voices.cta_clone', { defaultValue: 'Drop a 3s clip in Voice ← to clone one' })
                : t('voices.cta_design', { defaultValue: 'Describe one in Voice ← to design it' })}
            </button>
          </div>
        ) : (
          items.map((proj) => {
            const accent = proj.is_locked
              ? '#b8bb26'
              : defineMethod === 'audio'
                ? '#d3869b'
                : '#8ec07c';
            const KindIcon = proj.is_locked ? Lock : defineMethod === 'audio' ? Fingerprint : Wand2;
            return (
              <div
                key={proj.id}
                className={`history-item ${selectedProfile === proj.id ? 'project-active' : ''}`}
                style={{ '--row-accent': accent }}
                onClick={() => handleSelectProfile(proj)}
              >
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span
                    className="history-kind"
                    style={{ color: accent, borderColor: `${accent}40` }}
                  >
                    <KindIcon size={9} />{' '}
                    {proj.is_locked
                      ? t('sidebar.locked')
                      : defineMethod === 'audio'
                        ? t('sidebar.clone_label')
                        : t('sidebar.design_label')}
                  </span>
                  {proj.is_locked ? (
                    <span className="history-meta history-meta--locked">
                      {t('sidebar.consistent')}
                    </span>
                  ) : null}
                </div>
                <div className="history-title">{proj.name}</div>
                {proj.instruct ? (
                  <div className="history-subtitle history-subtitle--italic">{proj.instruct}</div>
                ) : null}

                <div className="history-actions">
                  <button
                    className="history-action-btn history-action-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePreviewVoice(proj, e);
                    }}
                    title="Preview"
                  >
                    {previewLoading === proj.id ? (
                      <Loader className="spinner" size={10} />
                    ) : (
                      <Play size={10} />
                    )}
                  </button>
                  {openVoiceProfile && (
                    <button
                      className="history-action-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        openVoiceProfile(proj.id);
                      }}
                      title="Open full profile"
                    >
                      {t('sidebar.open')}
                    </button>
                  )}
                  <button
                    className="history-action-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectProfile(proj);
                    }}
                  >
                    <Check size={10} /> {t('sidebar.select')}
                  </button>
                  {onOpenVoicePreview && (
                    <button
                      className="history-action-btn accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenVoicePreview(proj.id);
                      }}
                      title="Open interactive voice preview"
                    >
                      <Volume2 size={10} /> {t('sidebar.try_voice')}
                    </button>
                  )}
                  {proj.is_locked ? (
                    <button
                      className="history-action-btn accent history-action-icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleUnlockProfile(proj.id);
                      }}
                      title="Unlock"
                    >
                      <Unlock size={10} />
                    </button>
                  ) : null}
                  <button
                    className="history-action-btn danger history-action-icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteProfile(proj.id);
                    }}
                    title="Delete"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
