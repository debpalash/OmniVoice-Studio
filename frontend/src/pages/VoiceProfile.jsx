import React, { useEffect, useState, useCallback, useRef } from 'react';
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
  const [profile, setProfile] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);

  // Try-it panel
  const [testText, setTestText] = useState('Hello — this is a test of this voice.');
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
      toast.error("Voice profile needs a name.");
      return;
    }
    setSaving(true);
    try {
      const next = await updateProfile(voiceId, draft);
      setProfile(next);
      setEditing(false);
      toast.success('Saved');
    } catch (e) {
      toast.error(`Save failed: ${e.message}`);
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
    if (!(await askConfirm(`Delete "${profile.name}" permanently? This also removes the reference audio on disk.`))) return;
    try {
      await deleteProfile(voiceId);
      toast.success('Voice deleted');
      onDeleted?.();
    } catch (e) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  const onUnlock = async () => {
    if (!(await askConfirm('Unlock this voice? Future generations will no longer be bit-reproducible.'))) return;
    try {
      await unlockProfile(voiceId);
      await reload();
      toast.success('Voice unlocked');
    } catch (e) {
      toast.error(`Unlock failed: ${e.message}`);
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
      toast.error(`Generation failed: ${e.message}`);
    } finally {
      setTestGenerating(false);
    }
  };

  if (loading && !profile) {
    return (
      <div className="voice-profile voice-profile--loading">
        <Sparkles className="spinner" size={24} color="#d3869b" />
        <span>Loading voice…</span>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="voice-profile voice-profile--empty">
        <p>Voice not found.</p>
        <Button variant="subtle" onClick={onBack} leading={<ArrowLeft size={12} />}>Back</Button>
      </div>
    );
  }

  const isDesign = !!profile.instruct && !profile.ref_audio_path;
  const TypeIcon = isDesign ? Wand2 : Fingerprint;
  const kind = isDesign ? 'Designed' : 'Cloned';
  const createdDate = profile.created_at
    ? new Date(profile.created_at * 1000).toLocaleString()
    : '—';
  const audioUrl = `${API}/profiles/${voiceId}/audio?t=${profile.is_locked ? 'locked' : 'ref'}`;

  return (
    <div className="voice-profile">
      {/* Toolbar */}
      <div className="voice-profile__bar">
        <Button variant="ghost" size="sm" onClick={onBack} leading={<ArrowLeft size={12} />}>
          Back
        </Button>
        <span className="voice-profile__crumb">
          <TypeIcon size={12} /> {kind} voice
        </span>
        <div className="voice-profile__bar-spacer" />
        {!editing && (
          <Button variant="subtle" size="sm" onClick={() => setEditing(true)} leading={<Pencil size={12} />}>
            Edit
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={onDelete} leading={<Trash2 size={12} />}>
          Delete
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
                placeholder="Voice name"
                autoFocus
              />
            ) : (
              <h1>{profile.name}</h1>
            )}
            <div className="voice-profile__badges">
              {profile.is_locked
                ? <Badge tone="warn" dot><Lock size={10} /> Locked</Badge>
                : <Badge tone="neutral">Free</Badge>}
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
              <Volume2 size={11} /> {profile.is_locked ? 'Locked reference' : 'Reference audio'}
            </div>
            <audio controls src={audioUrl} className="voice-profile__audio-el" preload="metadata" />
          </div>
        )}
      </Panel>

      {/* Editable details */}
      <Panel
        variant="flat"
        padding="md"
        title={<>Details</>}
        actions={editing ? (
          <>
            <Button variant="ghost"   size="sm" onClick={cancelEdits} leading={<X size={12} />}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={saveEdits}   loading={saving} leading={!saving && <Check size={12} />}>Save</Button>
          </>
        ) : null}
      >
        <div className="voice-profile__grid-2">
          <Field label="Style instruct">
            {editing ? (
              <Textarea
                rows={2}
                value={draft.instruct}
                onChange={e => setDraft({ ...draft, instruct: e.target.value })}
                placeholder="e.g. whisper, excited, gentle"
              />
            ) : (
              <div className="voice-profile__readonly">
                {profile.instruct || <em>— none —</em>}
              </div>
            )}
          </Field>
          <Field label="Language">
            {editing ? (
              <Input
                value={draft.language}
                onChange={e => setDraft({ ...draft, language: e.target.value })}
                placeholder="Auto"
              />
            ) : (
              <div className="voice-profile__readonly">{profile.language || 'Auto'}</div>
            )}
          </Field>
        </div>
        <Field label="Reference transcript" hint="What the reference audio says. Used to improve clone accuracy.">
          {editing ? (
            <Textarea
              rows={2}
              value={draft.ref_text}
              onChange={e => setDraft({ ...draft, ref_text: e.target.value })}
              placeholder="(Optional)"
            />
          ) : (
            <div className="voice-profile__readonly voice-profile__readonly--transcript">
              {profile.ref_text || <em>— none —</em>}
            </div>
          )}
        </Field>
        {profile.is_locked && !editing && (
          <div className="voice-profile__lock-row">
            <Badge tone="warn" dot><Lock size={10} /> Locked</Badge>
            <span className="voice-profile__lock-hint">
              This voice is bit-reproducible. Every generation uses the same reference + seed.
            </span>
            <Button variant="subtle" size="sm" onClick={onUnlock} leading={<Unlock size={12} />}>Unlock</Button>
          </div>
        )}
      </Panel>

      {/* Try-it */}
      <Panel
        variant="flat"
        padding="md"
        title={<><Play size={13} /> Try this voice</>}
      >
        <Field
          label="Test phrase"
          hint="Type anything — we'll generate it with this voice's current settings."
        >
          <Textarea
            rows={2}
            value={testText}
            onChange={e => setTestText(e.target.value)}
            placeholder="Type something to hear this voice say it…"
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
            {testGenerating ? 'Generating…' : 'Generate preview'}
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
      <Panel variant="flat" padding="md" title={<>Where this voice has been used</>}>
        {!usage || (!usage.synth_total && !usage.projects?.length) ? (
          <div className="voice-profile__usage-empty">
            This voice hasn't been used yet. Generate a preview above, or pick it in a dub.
          </div>
        ) : (
          <>
            <div className="voice-profile__usage-counts">
              <Badge tone="brand">
                {usage.synth_total} synth clip{usage.synth_total === 1 ? '' : 's'}
              </Badge>
              <Badge tone="info">
                {usage.projects.length} project{usage.projects.length === 1 ? '' : 's'}
              </Badge>
              <Badge tone="success">
                {usage.project_total_segments} dubbed segment{usage.project_total_segments === 1 ? '' : 's'}
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
