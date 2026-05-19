import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  ArrowLeft, Fingerprint, Wand2, Lock, Unlock, Trash2, Play, Save,
  FolderOpen, Volume2, Clock, Pencil, Check, X, Sparkles,
} from 'lucide-react';
import { Panel, Button, Input, Textarea, Field, Badge, Segmented, Progress } from '../ui';
import {
  getProfile, getProfileUsage, updateProfile, deleteProfile, unlockProfile,
} from '../api/profiles';
import { generateSpeech } from '../api/generate';
import { API } from '../api/client';
import './VoiceProfile.css';
import { askConfirm } from '../utils/dialog';

/**
 * VoiceProfile — per-voice detail page.
 *
 * Route (via App mode):
 *   mode === 'voice' && activeVoiceId set.
 *
 * Props:
 *   voiceId       string
 *   onBack()      return to previous mode
 *   onOpenProject(id)  navigate to a dub project (from usage list)
 *   onDeleted()   called after successful delete
 */
export default function VoiceProfile({ voiceId, onBack, onOpenProject, onDeleted }) {
  const { t } = useTranslation();

  const [profile, setProfile] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Try-it panel
  const [testText, setTestText] = useState(t('voice.defaultTestPhrase', { defaultValue: 'Hello — this is a test of this voice.' }));
  const [testGenerating, setTestGenerating] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState(null);
  const testAudioRef = useRef(null);

  const reload = useCallback(async () => {
    if (!voiceId) return;
    setLoading(true);
    try {
      const [p, u] = await Promise.all([getProfile(voiceId), getProfileUsage(voiceId)]);
      setProfile(p);
      setUsage(u);
      setDraft({
        name: p.name || '',
        instruct: p.instruct || '',
        language: p.language || 'Auto',
        ref_text: p.ref_text || '',
      });
    } catch (e) {
      toast.error(e.message || t('voice.loadFailed', { defaultValue: 'Failed to load voice' }));
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [voiceId]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => () => {
    // Clean up any blob URL when the page unmounts.
    if (testAudioUrl && testAudioUrl.startsWith('blob:')) URL.revokeObjectURL(testAudioUrl);
  }, [testAudioUrl]);

  const saveEdits = async () => {
    if (!draft.name.trim()) {
      toast.error(t('voice.voice_name_required'));
      return;
    }
    setSaving(true);
    try {
      const next = await updateProfile(voiceId, draft);
      setProfile(next);
      setEditing(false);
      toast.success(t('voice.voice_saved'));
    } catch (e) {
      toast.error(t('voice.save_failed', { msg: e.message }));
    } finally {
      setSaving(false);
    }
  };

  const cancelEdits = () => {
    setDraft({
      name: profile.name || '',
      instruct: profile.instruct || '',
      language: profile.language || 'Auto',
      ref_text: profile.ref_text || '',
    });
    setEditing(false);
  };

  const onDelete = async () => {
    if (!(await askConfirm(t('voice.delete_voice_confirm', { name: profile.name })))) return;
    try {
      await deleteProfile(voiceId);
      toast.success(t('voice.voice_deleted'));
      onDeleted?.();
    } catch (e) {
      toast.error(t('voice.delete_failed', { msg: e.message }));
    }
  };

  const onUnlock = async () => {
    if (!(await askConfirm(t('voice.unlock_confirm')))) return;
    try {
      await unlockProfile(voiceId);
      await reload();
      toast.success(t('voice.voice_unlocked'));
    } catch (e) {
      toast.error(t('voice.unlock_failed', { msg: e.message }));
    }
  };

  const runTest = async () => {
    if (!testText.trim()) return;
    setTestGenerating(true);
    try {
      const fd = new FormData();
      fd.append('text', testText);
      fd.append('profile_id', voiceId);
      if (profile.instruct) fd.append('instruct', profile.instruct);
      fd.append('num_step', 16);
      fd.append('guidance_scale', 2.0);
      fd.append('speed', 1.0);
      fd.append('denoise', true);
      fd.append('postprocess_output', true);
      const res = await generateSpeech(fd);
      const blob = await res.blob();
      if (testAudioUrl && testAudioUrl.startsWith('blob:')) URL.revokeObjectURL(testAudioUrl);
      const url = URL.createObjectURL(blob);
      setTestAudioUrl(url);
      setTimeout(() => testAudioRef.current?.play?.(), 80);
    } catch (e) {
      toast.error(t('voice.generation_failed', { msg: e.message }));
    } finally {
      setTestGenerating(false);
    }
  };

  if (loading && !profile) {
    return (
      <div className="voice-profile voice-profile--loading">
        <Sparkles className="spinner" size={24} color="#d3869b" />
        <span>{t('voice.loading_voice')}</span>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="voice-profile voice-profile--empty">
        <p>{t('voice.voice_not_found')}</p>
        <Button variant="subtle" onClick={onBack} leading={<ArrowLeft size={12} />}>{t('common.back')}</Button>
      </div>
    );
  }

  const isDesign = !!profile.instruct && !profile.ref_audio_path;
  const TypeIcon = isDesign ? Wand2 : Fingerprint;
  const kind = isDesign ? t('voice.voice_designed_kind') : t('voice.voice_cloned_kind');
  const createdDate = profile.created_at
    ? new Date(profile.created_at * 1000).toLocaleString()
    : '—';
  const audioUrl = `${API}/profiles/${voiceId}/audio?t=${profile.is_locked ? 'locked' : 'ref'}`;

  return (
    <div className="voice-profile">
      {/* Toolbar */}
      <div className="voice-profile__bar">
        <Button variant="ghost" size="sm" onClick={onBack} leading={<ArrowLeft size={12} />}>
          {t('common.back')}
        </Button>
        <span className="voice-profile__crumb">
          <TypeIcon size={12} /> {t('voice.voice_kind_label', { kind })}
        </span>
        <div className="voice-profile__bar-spacer" />
        {!editing && (
          <Button variant="subtle" size="sm" onClick={() => setEditing(true)} leading={<Pencil size={12} />}>
            {t('common.edit', { defaultValue: 'Edit' })}
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={onDelete} leading={<Trash2 size={12} />}>
          {t('common.delete')}
        </Button>
      </div>

      {/* Hero */}
      <Panel variant="glass" padding="md" className="voice-profile__hero">
        <div className="voice-profile__hero-left">
          <div className="voice-profile__icon-badge" data-kind={isDesign ? 'design' : 'clone'}>
            <TypeIcon size={22} />
          </div>
          <div className="voice-profile__hero-title">
            {editing ? (
              <Input
                size="lg"
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('voice.name_placeholder')}
                autoFocus
              />
            ) : (
              <h1>{profile.name}</h1>
            )}
            <div className="voice-profile__badges">
              {profile.is_locked
                ? <Badge tone="warn" dot><Lock size={10} /> {t('voice.voice_locked_badge')}</Badge>
                : <Badge tone="neutral">{t('voice.voice_free_badge')}</Badge>}
              {profile.language && profile.language !== 'Auto' && (
                <Badge tone="info">{profile.language}</Badge>
              )}
              <Badge tone="neutral" size="xs">
                <Clock size={9} /> {createdDate}
              </Badge>
              {profile.seed != null && (
                <Badge tone="violet" size="xs">{t('voice.voice_seed_badge', { seed: profile.seed })}</Badge>
              )}
            </div>
          </div>
        </div>

        {(profile.ref_audio_path || profile.locked_audio_path) && (
          <div className="voice-profile__audio">
            <div className="voice-profile__audio-label">
              <Volume2 size={11} /> {profile.is_locked ? t('voice.locked_reference') : t('voice.reference_audio')}
            </div>
            <audio controls src={audioUrl} className="voice-profile__audio-el" preload="metadata" />
          </div>
        )}
      </Panel>

      {/* Editable details */}
      <Panel
        variant="flat"
        padding="md"
        title={t('voice.details')}
        actions={editing ? (
          <>
            <Button variant="ghost"   size="sm" onClick={cancelEdits} leading={<X size={12} />}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={saveEdits}   loading={saving} leading={!saving && <Check size={12} />}>{t('common.save')}</Button>
          </>
        ) : null}
      >
        <div className="voice-profile__grid-2">
          <Field label={t('voice.style_instruct')}>
            {editing ? (
              <Textarea
                rows={2}
                value={draft.instruct}
                onChange={e => setDraft({ ...draft, instruct: e.target.value })}
                placeholder={t('voice.style_instruct_placeholder')}
              />
            ) : (
              <div className="voice-profile__readonly">
                {profile.instruct || <em>{t('voice.none_fallback')}</em>}
              </div>
            )}
          </Field>
          <Field label={t('voice.language')}>
            {editing ? (
              <Input
                value={draft.language}
                onChange={e => setDraft({ ...draft, language: e.target.value })}
                placeholder={t('common.auto')}
              />
            ) : (
              <div className="voice-profile__readonly">{profile.language || t('common.auto')}</div>
            )}
          </Field>
        </div>
        <Field label={t('voice.reference_text')} hint={t('voice.reference_text_hint')}>
          {editing ? (
            <Textarea
              rows={2}
              value={draft.ref_text}
              onChange={e => setDraft({ ...draft, ref_text: e.target.value })}
              placeholder={t('voice.reference_text_placeholder')}
            />
          ) : (
            <div className="voice-profile__readonly voice-profile__readonly--transcript">
              {profile.ref_text || <em>{t('voice.none_fallback')}</em>}
            </div>
          )}
        </Field>
        {profile.is_locked && !editing && (
          <div className="voice-profile__lock-row">
            <Badge tone="warn" dot><Lock size={10} /> {t('voice.voice_locked_badge')}</Badge>
            <span className="voice-profile__lock-hint">
              {t('voice.bit_reproducible_hint')}
            </span>
            <Button variant="subtle" size="sm" onClick={onUnlock} leading={<Unlock size={12} />}>{t('voice.unlock')}</Button>
          </div>
        )}
      </Panel>

      {/* Try-it */}
      <Panel
        variant="flat"
        padding="md"
        title={<><Play size={13} /> {t('voice.try_this_voice')}</>}
      >
        <Field
          label={t('components.test_phrase')}
          hint={t('voice.try_this_voice_hint')}
        >
          <Textarea
            rows={2}
            value={testText}
            onChange={e => setTestText(e.target.value)}
            placeholder={t('voice.preview_text_placeholder')}
          />
        </Field>
        <div className="voice-profile__tryit-actions">
          <Button
            variant="primary"
            size="sm"
            loading={testGenerating}
            onClick={runTest}
            disabled={!testText.trim()}
            leading={!testGenerating && <Sparkles size={12} />}
          >
            {testGenerating ? t('voice.generating') : t('voice.preview_generate', { defaultValue: 'Generate preview' })}
          </Button>
          {testAudioUrl && (
            <audio
              ref={testAudioRef}
              controls
              src={testAudioUrl}
              className="voice-profile__tryit-audio"
              preload="auto"
            />
          )}
        </div>
      </Panel>

      {/* Usage */}
      <Panel variant="flat" padding="md" title={t('voice.where_used')}>
        {!usage || (!usage.synth_total && !usage.projects?.length) ? (
          <div className="voice-profile__usage-empty">
            {t('voice.voice_unused')}
          </div>
        ) : (
          <>
            <div className="voice-profile__usage-counts">
              <Badge tone="brand">
                {usage.synth_total} {t('voice.synth_clips')}
              </Badge>
              <Badge tone="info">
                {usage.projects.length} {t('voice.projects_label')}
              </Badge>
              <Badge tone="success">
                {usage.project_total_segments} {t('voice.dubbed_segments')}
              </Badge>
            </div>
            {usage.projects.length > 0 && (
              <ul className="voice-profile__usage-list">
                {usage.projects.slice(0, 10).map(p => (
                  <li key={p.project_id}>
                    <button
                      type="button"
                      onClick={() => onOpenProject?.(p.project_id)}
                      className="voice-profile__usage-link"
                    >
                      <FolderOpen size={11} />
                      <span className="voice-profile__usage-name">{p.project_name}</span>
                      <span className="voice-profile__usage-count">{p.segment_count} {t('voice.segs')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
