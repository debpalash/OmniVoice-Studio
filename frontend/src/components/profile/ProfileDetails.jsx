import { X, Check, Lock, Unlock, ShieldCheck, Square, Mic } from 'lucide-react';
import { Panel, Button, Input, Textarea, Field, Badge } from '../../ui';

/**
 * ProfileDetails — editable details panel + consent-lock panel for the
 * VoiceProfile page. Pure presentation; state/handlers live in the parent.
 */
export default function ProfileDetails({
  profile,
  editing,
  draft,
  setDraft,
  saving,
  cancelEdits,
  saveEdits,
  onUnlock,
  onRevokeConsent,
  consentStatement,
  consentRec,
  consentSubmitting,
  t,
}) {
  return (
    <>
      {/* Editable details */}
      <Panel
        variant="flat"
        padding="md"
        title={<>{t('voice_profile.details')}</>}
        actions={
          editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={cancelEdits} leading={<X size={12} />}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={saveEdits}
                loading={saving}
                leading={!saving && <Check size={12} />}
              >
                {t('common.save')}
              </Button>
            </>
          ) : null
        }
      >
        <div className="voice-profile__grid-2">
          <Field label={t('voice_profile.style_instruct')}>
            {editing ? (
              <Textarea
                rows={2}
                value={draft.instruct}
                onChange={(e) => setDraft({ ...draft, instruct: e.target.value })}
                placeholder={t('voice_profile.style_placeholder')}
              />
            ) : (
              <div className="voice-profile__readonly">{profile.instruct || <em>— none —</em>}</div>
            )}
          </Field>
          <Field label={t('voice_profile.language')}>
            {editing ? (
              <Input
                value={draft.language}
                onChange={(e) => setDraft({ ...draft, language: e.target.value })}
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
              onChange={(e) => setDraft({ ...draft, ref_text: e.target.value })}
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
            <Badge tone="warn" dot>
              <Lock size={10} /> {t('voice_profile.locked')}
            </Badge>
            <span className="voice-profile__lock-hint">{t('voice_profile.locked_explain')}</span>
            <Button variant="subtle" size="sm" onClick={onUnlock} leading={<Unlock size={12} />}>
              {t('voice_profile.unlock')}
            </Button>
          </div>
        )}
      </Panel>

      {/* Consent lock (Wave 0.2) — verify this is your own voice */}
      <Panel
        variant="flat"
        padding="md"
        title={
          <>
            <ShieldCheck size={12} /> {t('voice_profile.consent_title')}
          </>
        }
      >
        {profile.verified_own_voice ? (
          <div className="voice-profile__lock-row">
            <Badge tone="success" dot>
              <ShieldCheck size={10} /> {t('voice_profile.verified')}
            </Badge>
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
              <Button
                variant="danger"
                size="sm"
                onClick={consentRec.stopRecording}
                leading={<Square size={12} />}
              >
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
    </>
  );
}
