import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { toastErrorWithReport } from '../utils/errorToast';
import {
  ArrowLeft, Fingerprint, Wand2, Lock, Unlock, Trash2, Play, Save,
  FolderOpen, Volume2, Clock, Pencil, Check, X, Sparkles, ShieldCheck, Mic, Square,
} from 'lucide-react';
import { Panel, Button, Input, Textarea, Field, Badge, Segmented, Progress } from '../ui';
import {
  getProfile, getProfileUsage, updateProfile, deleteProfile, unlockProfile,
  recordConsent, revokeConsent,
} from '../api/profiles';
import useRecording from '../hooks/useRecording';
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
  const [testText, setTestText] = useState(t('voice_profile.test_text'));
  const [testGenerating, setTestGenerating] = useState(false);
  const [testAudioUrl, setTestAudioUrl] = useState(null);
  const testAudioRef = useRef(null);

  // Consent lock (Wave 0.2): record a spoken consent statement to mark the
  // profile as the owner's own voice. Agentic features and gallery sharing
  // gate on this flag; local synthesis never does.
  const [consentSubmitting, setConsentSubmitting] = useState(false);
  const consentStatement = t('voice_profile.consent_statement');
  const submitConsent = async (audioFile) => {
    setConsentSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('consent_audio', audioFile);
      fd.append('consent_text', consentStatement);
      await recordConsent(voiceId, fd);
      toast.success(t('voice_profile.consent_saved'));
      await reload();
    } catch (e) {
      toastErrorWithReport(t('voice_profile.consent_failed', { message: e.message }), e);
    } finally {
      setConsentSubmitting(false);
    }
  };
  const consentRec = useRecording(submitConsent);
  const onRevokeConsent = async () => {
    if (!(await askConfirm(t('voice_profile.consent_revoke_confirm')))) return;
    try {
      await revokeConsent(voiceId);
      toast.success(t('voice_profile.consent_revoked'));
      await reload();
    } catch (e) {
      toastErrorWithReport(e.message, e);
    }
  };

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
      toast.error(e.message || 'Failed to load voice');
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
      toast.error(t('voice_profile.needs_name'));
      return;
    }
    setSaving(true);
    try {
      const next = await updateProfile(voiceId, draft);
      setProfile(next);
      setEditing(false);
      toast.success(t('voice_profile.saved'));
    } catch (e) {
      toastErrorWithReport(t('voice_profile.save_failed', { message: e.message }), e);
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
    if (!(await askConfirm(t('voice_profile.delete_confirm', { name: profile.name })))) return;
    try {
      await deleteProfile(voiceId);
      toast.success(t('voice_profile.deleted'));
      onDeleted?.();
    } catch (e) {
      toastErrorWithReport(t('voice_profile.delete_failed', { message: e.message }), e);
    }
  };

  const onUnlock = async () => {
    if (!(await askConfirm(t('voice_profile.unlock_confirm')))) return;
    try {
      await unlockProfile(voiceId);
      await reload();
      toast.success(t('voice_profile.unlocked'));
    } catch (e) {
      toast.error(t('voice_profile.unlock_failed', { message: e.message }));
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
      toastErrorWithReport(t('voice_profile.gen_failed', { message: e.message }), e);
    } finally {
      setTestGenerating(false);
    }
  };

  if (loading && !profile) {
    return (
      <div className="voice-profile voice-profile--loading">
        <Sparkles className="spinner" size={24} color="#d3869b" />
        <span>{t('common.loading')}</span>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="voice-profile voice-profile--empty">
        <p>{t('voice_profile.not_found')}</p>
        <Button variant="subtle" onClick={onBack} leading={<ArrowLeft size={12} />}>{t('common.back')}</Button>
      </div>
    );
  }

  const isDesign = !!profile.instruct && !profile.ref_audio_path;
  const TypeIcon = isDesign ? Wand2 : Fingerprint;
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
          <TypeIcon size={12} /> {isDesign ? t('voice_profile.designed') : t('voice_profile.cloned')} voice
        </span>
        <div className="voice-profile__bar-spacer" />
        {!editing && (
          <Button variant="subtle" size="sm" onClick={() => setEditing(true)} leading={<Pencil size={12} />}>
            {t('voice_profile.edit')}
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
                placeholder={t('voice_profile.name_placeholder')}
                autoFocus
              />
            ) : (
              <h1>{profile.name}</h1>
            )}
            <div className="voice-profile__badges">
              {!!profile.verified_own_voice && (
                <Badge tone="success" dot><ShieldCheck size={10} /> {t('voice_profile.verified')}</Badge>
              )}
              {profile.is_locked
                ? <Badge tone="warn" dot><Lock size={10} /> {t('voice_profile.locked')}</Badge>
                : <Badge tone="neutral">{t('voice_profile.free')}</Badge>}
              {profile.language && profile.language !== 'Auto' && (
                <Badge tone="info">{profile.language}</Badge>
              )}
              <Badge tone="neutral" size="xs">
                <Clock size={9} /> {createdDate}
              </Badge>
              {profile.seed != null && (
                <Badge tone="violet" size="xs">seed {profile.seed}</Badge>
              )}
            </div>
          </div>
        </div>

        {(profile.ref_audio_path || profile.locked_audio_path) && (
          <div className="voice-profile__audio">
            <div className="voice-profile__audio-label">
              <Volume2 size={11} /> {profile.is_locked ? t('voice_profile.locked_ref') : t('voice_profile.ref_audio')}
            </div>
            <audio controls src={audioUrl} className="voice-profile__audio-el" preload="metadata" />
          </div>
        )}
      </Panel>

      {/* Editable details */}
      <Panel
        variant="flat"
        padding="md"
        title={<>{t('voice_profile.details')}</>}
        actions={editing ? (
          <>
            <Button variant="ghost"   size="sm" onClick={cancelEdits} leading={<X size={12} />}>{t('common.cancel')}</Button>
            <Button variant="primary" size="sm" onClick={saveEdits}   loading={saving} leading={!saving && <Check size={12} />}>{t('common.save')}</Button>
          </>
        ) : null}
      >
        <div className="voice-profile__grid-2">
          <Field label={t('voice_profile.style_instruct')}>
            {editing ? (
              <Textarea
                rows={2}
                value={draft.instruct}
                onChange={e => setDraft({ ...draft, instruct: e.target.value })}
                placeholder={t('voice_profile.style_placeholder')}
              />
            ) : (
              <div className="voice-profile__readonly">
                {profile.instruct || <em>— none —</em>}
              </div>
            )}
          </Field>
          <Field label={t('voice_profile.language')}>
            {editing ? (
              <Input
                value={draft.language}
                onChange={e => setDraft({ ...draft, language: e.target.value })}
                placeholder={t('clone.auto')}
              />
            ) : (
              <div className="voice-profile__readonly">{profile.language || 'Auto'}</div>
            )}
          </Field>
        </div>
        <Field label={t('voice_profile.ref_transcript')} hint={t('voice_profile.ref_help')}>
          {editing ? (
            <Textarea
              rows={2}
              value={draft.ref_text}
              onChange={e => setDraft({ ...draft, ref_text: e.target.value })}
              placeholder={t('clone.optional')}
            />
          ) : (
            <div className="voice-profile__readonly voice-profile__readonly--transcript">
              {profile.ref_text || <em>— none —</em>}
            </div>
          )}
        </Field>
        {profile.is_locked && !editing && (
          <div className="voice-profile__lock-row">
            <Badge tone="warn" dot><Lock size={10} /> {t('voice_profile.locked')}</Badge>
            <span className="voice-profile__lock-hint">
              {t('voice_profile.locked_explain')}
            </span>
            <Button variant="subtle" size="sm" onClick={onUnlock} leading={<Unlock size={12} />}>{t('voice_profile.unlock')}</Button>
          </div>
        )}
      </Panel>

      {/* Consent lock (Wave 0.2) — verify this is your own voice */}
      <Panel
        variant="flat"
        padding="md"
        title={<><ShieldCheck size={12} /> {t('voice_profile.consent_title')}</>}
      >
        {profile.verified_own_voice ? (
          <div className="voice-profile__lock-row">
            <Badge tone="success" dot><ShieldCheck size={10} /> {t('voice_profile.verified')}</Badge>
            <span className="voice-profile__lock-hint">
              {t('voice_profile.consent_verified_explain', {
                date: profile.consent_recorded_at
                  ? new Date(profile.consent_recorded_at * 1000).toLocaleDateString()
                  : '',
              })}
            </span>
            <Button variant="subtle" size="sm" onClick={onRevokeConsent} leading={<X size={12} />}>
              {t('voice_profile.consent_revoke')}
            </Button>
          </div>
        ) : (
          <>
            <p className="voice-profile__readonly">{t('voice_profile.consent_explain')}</p>
            <blockquote className="voice-profile__readonly voice-profile__readonly--transcript">
              “{consentStatement}”
            </blockquote>
            {consentRec.isRecording ? (
              <Button variant="danger" size="sm" onClick={consentRec.stopRecording} leading={<Square size={12} />}>
                {t('voice_profile.consent_stop')} ({consentRec.recordingTime}s)
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={consentRec.startRecording}
                loading={consentSubmitting || consentRec.isCleaning}
                leading={!(consentSubmitting || consentRec.isCleaning) && <Mic size={12} />}
              >
                {t('voice_profile.consent_record')}
              </Button>
            )}
          </>
        )}
      </Panel>

      {/* Try-it */}
      <Panel
        variant="flat"
        padding="md"
        title={<><Play size={13} /> {t('voice_profile.try_voice')}</>}
      >
        <Field
          label={t('voice_profile.test_phrase')}
          hint={t('voice_profile.test_help')}
        >
          <Textarea
            rows={2}
            value={testText}
            onChange={e => setTestText(e.target.value)}
            placeholder={t('voice_profile.test_placeholder')}
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
            {testGenerating ? t('voice_profile.generating') : t('voice_profile.gen_preview')}
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
      <Panel variant="flat" padding="md" title={<>{t('voice_profile.used_title')}</>}>
        {!usage || (!usage.synth_total && !usage.projects?.length) ? (
          <div className="voice-profile__usage-empty">
            {t('voice_profile.used_empty')}
          </div>
        ) : (
          <>
            <div className="voice-profile__usage-counts">
              <Badge tone="brand">
                {t('voice_profile.synth_clips', { count: usage.synth_total })}
              </Badge>
              <Badge tone="info">
                {t('voice_profile.projects_count', { count: usage.projects.length })}
              </Badge>
              <Badge tone="success">
                {t('voice_profile.dubbed_segments', { count: usage.project_total_segments })}
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
                      <span className="voice-profile__usage-count">{p.segment_count} segs</span>
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
