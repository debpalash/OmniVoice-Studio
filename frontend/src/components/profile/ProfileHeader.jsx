import {
  ArrowLeft,
  Pencil,
  Download,
  Trash2,
  ShieldCheck,
  Lock,
  Clock,
  Volume2,
} from 'lucide-react';
import { Panel, Button, Input, Badge } from '../../ui';
import WaveformPlayer from '../WaveformPlayer';

/**
 * ProfileHeader — toolbar + hero (identity) for the VoiceProfile page.
 * Pure presentation; all state/handlers live in the parent VoiceProfile.
 */
export default function ProfileHeader({
  profile,
  isDesign,
  TypeIcon,
  onBack,
  editing,
  setEditing,
  includeReference,
  setIncludeReference,
  onExportPersona,
  exporting,
  onDelete,
  draft,
  setDraft,
  createdDate,
  audioUrl,
  t,
}) {
  return (
    <>
      {/* Toolbar */}
      <div className="voice-profile__bar">
        <Button variant="ghost" size="sm" onClick={onBack} leading={<ArrowLeft size={12} />}>
          {t('common.back')}
        </Button>
        <span className="voice-profile__crumb">
          <TypeIcon size={12} />{' '}
          {isDesign ? t('voice_profile.designed') : t('voice_profile.cloned')} voice
        </span>
        <div className="voice-profile__bar-spacer" />
        {!editing && (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => setEditing(true)}
            leading={<Pencil size={12} />}
          >
            {t('voice_profile.edit')}
          </Button>
        )}
        {!editing && (
          <label
            className="voice-profile__persona-privacy"
            title={t('voice_profile.persona_include_ref_hint', {
              defaultValue:
                'Include the raw reference clip. Off = share only a watermarked preview (recommended).',
            })}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}
          >
            <input
              type="checkbox"
              checked={includeReference}
              onChange={(e) => setIncludeReference(e.target.checked)}
            />
            {t('voice_profile.persona_include_ref', { defaultValue: 'Include voice clip' })}
          </label>
        )}
        {!editing && (
          <Button
            variant="subtle"
            size="sm"
            onClick={onExportPersona}
            loading={exporting}
            leading={!exporting && <Download size={12} />}
          >
            {t('voice_profile.persona_export', { defaultValue: 'Export persona' })}
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
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('voice_profile.name_placeholder')}
                autoFocus
              />
            ) : (
              <h1>{profile.name}</h1>
            )}
            <div className="voice-profile__badges">
              {!!profile.verified_own_voice && (
                <Badge tone="success" dot>
                  <ShieldCheck size={10} /> {t('voice_profile.verified')}
                </Badge>
              )}
              {profile.is_locked ? (
                <Badge tone="warn" dot>
                  <Lock size={10} /> {t('voice_profile.locked')}
                </Badge>
              ) : (
                <Badge tone="neutral">{t('voice_profile.free')}</Badge>
              )}
              {profile.language && profile.language !== 'Auto' && (
                <Badge tone="info">{profile.language}</Badge>
              )}
              <Badge tone="neutral" size="xs">
                <Clock size={9} /> {createdDate}
              </Badge>
              {profile.seed != null && (
                <Badge tone="violet" size="xs">
                  seed {profile.seed}
                </Badge>
              )}
            </div>
          </div>
        </div>

        {(profile.ref_audio_path || profile.locked_audio_path) && (
          <div className="voice-profile__audio">
            <div className="voice-profile__audio-label">
              <Volume2 size={11} />{' '}
              {profile.is_locked ? t('voice_profile.locked_ref') : t('voice_profile.ref_audio')}
            </div>
            <WaveformPlayer
              src={audioUrl}
              source="profile-ref"
              className="voice-profile__audio-el"
            />
          </div>
        )}
      </Panel>
    </>
  );
}
