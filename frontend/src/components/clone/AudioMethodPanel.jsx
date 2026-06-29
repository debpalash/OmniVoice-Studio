import { UploadCloud, X, Save, Dice5 } from 'lucide-react';
import { Button, Input } from '../../ui';
import MicButton from './MicButton';

export default function AudioMethodPanel({
  t, selectedProfile, setSelectedProfile, profiles, ingestRefAudio, refAudio,
  isCleaning, isRecording, recordingTime, startRecording, stopRecording,
  refText, setRefText, instruct, setInstruct,
  defineMethod, designSeed, setDesignSeed, keepSeed, setKeepSeed,
  showSaveProfile, setShowSaveProfile, profileName, setProfileName, handleSaveProfile,
}) {
  return (
          <div>
            {/* Saved voices now live in the right-side WorkspaceVoices panel. */}

            {!selectedProfile && (
              <div className="clone-drop-row">
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
                  onChange={e => { const f = e.target.files[0]; ingestRefAudio(f); e.target.value = ''; }}
                  className="dub-hidden-file"
                  id="audio-upload"
                />
                <label
                  htmlFor="audio-upload"
                  className="file-drag clone-drop-zone"
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-dragging'); }}
                  onDragLeave={e => { e.currentTarget.classList.remove('is-dragging'); }}
                  onDrop={e => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('is-dragging');
                    const file = e.dataTransfer.files[0];
                    const okType = file && (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|flac|ogg|aac|webm)$/i.test(file.name));
                    if (okType) ingestRefAudio(file);
                  }}
                >
                  <UploadCloud color="#a89984" size={18} />
                  <p>{refAudio ? <span className="clone-drop-filename">{refAudio.name}</span> : t('clone.drop_audio')}</p>
                </label>

                <MicButton
                  isCleaning={isCleaning}
                  isRecording={isRecording}
                  recordingTime={recordingTime}
                  onStart={startRecording}
                  onStop={stopRecording}
                />
              </div>
            )}

            {selectedProfile && (
              <div className="clone-profile-banner">
                <span className="clone-profile-banner__label">
                  {t('clone.using_profile', { name: profiles.find(p => p.id === selectedProfile)?.name })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedProfile(null)}
                  leading={<X size={11} />}
                >
                  {t('clone.clear')}
                </Button>
              </div>
            )}

            <div className="grid-2 grid-2--indent">
              <div>
                <div className="label-row">{t('clone.transcript')}</div>
                <input type="text" className="input-base" value={refText} onChange={e => setRefText(e.target.value)} placeholder={t('clone.optional')} />
              </div>
              <div>
                <div className="label-row">{t('clone.style')}</div>
                <input type="text" className="input-base" value={instruct} onChange={e => setInstruct(e.target.value)} placeholder={t('clone.style_placeholder')} />
              </div>
            </div>

            {/* #526: voice-design seed — show + pin + re-roll so tweaks can
                stay on the same base timbre. Design mode only. */}
            {defineMethod === 'design' && (
              <div className="design-seed">
                <div className="label-row">{t('clone.seed_label')}</div>
                <div className="design-seed__row">
                  <input
                    type="number"
                    className="input-base design-seed__input"
                    value={designSeed ?? ''}
                    placeholder={t('clone.seed_placeholder')}
                    onChange={e => {
                      const v = e.target.value.trim();
                      if (v === '') { setDesignSeed(null); return; }
                      const n = parseInt(v, 10);
                      if (Number.isInteger(n)) { setDesignSeed(n); setKeepSeed(true); }
                    }}
                  />
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => { setDesignSeed(Math.floor(Math.random() * 2147483647)); setKeepSeed(true); }}
                    leading={<Dice5 size={12} />}
                    title={t('clone.seed_reroll_hint')}
                  >
                    {t('clone.seed_reroll')}
                  </Button>
                  <label className="design-seed__keep">
                    <input type="checkbox" checked={keepSeed} onChange={e => setKeepSeed(e.target.checked)} />
                    <span>{t('clone.seed_keep')}</span>
                  </label>
                </div>
              </div>
            )}

            {/* Save as profile */}
            {refAudio && !selectedProfile && (
              <div className="clone-save-profile">
                {!showSaveProfile ? (
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setShowSaveProfile(true)}
                    leading={<Save size={12} />}
                  >
                    {t('clone.save_as_profile')}
                  </Button>
                ) : (
                  <div className="clone-save-profile__row">
                    <Input
                      size="sm"
                      placeholder={t('clone.profile_name')}
                      value={profileName}
                      onChange={e => setProfileName(e.target.value)}
                    />
                    <Button variant="subtle" size="sm" onClick={handleSaveProfile}>{t('clone.save')}</Button>
                    <Button variant="ghost"  size="sm" onClick={() => setShowSaveProfile(false)}>{t('clone.cancel')}</Button>
                  </div>
                )}
              </div>
            )}
          </div>
  );
}
