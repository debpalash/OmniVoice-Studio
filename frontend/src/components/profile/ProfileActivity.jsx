import { Play, Sparkles, FolderOpen } from 'lucide-react';
import { Panel, Button, Textarea, Field, Badge } from '../../ui';
import WaveformPlayer from '../WaveformPlayer';

/**
 * ProfileActivity — "Try it" preview panel + usage panel for the VoiceProfile
 * page. Pure presentation; state/handlers live in the parent VoiceProfile.
 */
export default function ProfileActivity({
  t, testText, setTestText, testGenerating, runTest, testAudioUrl,
  autoPlayPreview, usage, onOpenProject,
}) {
  return (
    <>
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
            <WaveformPlayer
              src={testAudioUrl}
              source="profile-test"
              autoPlay={autoPlayPreview}
              className="voice-profile__tryit-audio"
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
    </>
  );
}
