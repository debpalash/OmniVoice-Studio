import React, { useState, useCallback } from 'react';
import { User, Mic, ChevronDown, Check, Shuffle, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import './CastingView.css';

/**
 * CastingView — assign voice profiles to speakers for dubbing projects.
 *
 * Shows each detected speaker as a row, with a dropdown to pick a voice
 * profile (from saved profiles or auto-clones from the video). Drag-and-drop
 * is scaffolded for a future pass.
 *
 * Props:
 *   speakers: [{ id, label, segments_count }]
 *   profiles: [{ id, name, type, personality }]
 *   autoClones: { speaker_id: { ref_audio, ref_text } }
 *   assignments: { speaker_id: profile_id | "auto:speaker_id" }
 *   onChange: (assignments) => void
 *   onPreview: (profile_id) => void
 */
export default function CastingView({
  speakers = [],
  profiles = [],
  autoClones = {},
  assignments = {},
  onChange,
  onPreview,
}) {
  const [openDropdown, setOpenDropdown] = useState(null);
  const { t } = useTranslation();

  const assign = useCallback((speakerId, profileId) => {
    const next = { ...assignments, [speakerId]: profileId };
    onChange?.(next);
    setOpenDropdown(null);
  }, [assignments, onChange]);

  const autoAssignAll = useCallback(() => {
    const next = {};
    speakers.forEach((s) => {
      // Prefer auto-clone if available, else keep existing assignment
      if (autoClones[s.id]) {
        next[s.id] = `auto:${s.id}`;
      } else if (assignments[s.id]) {
        next[s.id] = assignments[s.id];
      }
    });
    onChange?.(next);
  }, [speakers, autoClones, assignments, onChange]);

  if (speakers.length === 0) return null;

  const allAssigned = speakers.every(s => assignments[s.id]);

  return (
    <div className="casting-view">
      <div className="casting-view__header">
        <h3 className="casting-view__title">
          <User size={14} /> {t('casting.title')}
        </h3>
        <div className="casting-view__actions">
          <button
            className="casting-view__auto-btn"
            onClick={autoAssignAll}
            title={t('casting.auto_assign_title')}
          >
            <Shuffle size={12} /> {t('casting.auto_cast')}
          </button>
          {allAssigned && (
            <span className="casting-view__badge">
              <Check size={10} /> {t('casting.all_cast')}
            </span>
          )}
        </div>
      </div>

      <div className="casting-view__grid">
        {speakers.map((speaker) => {
          const currentAssignment = assignments[speaker.id];
          const isAuto = currentAssignment?.startsWith('auto:');
          let autoName = speaker.label;
          if (isAuto && currentAssignment) {
            const match = Object.keys(autoClones || {}).find(spk => `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}` === currentAssignment);
            if (match) autoName = match;
          }
          const assignedProfile = isAuto
            ? { name: t('casting.from_video', { name: autoName }), type: 'clone' }
            : profiles.find(p => p.id === currentAssignment);

          return (
            <div
              key={speaker.id}
              className={`casting-row ${currentAssignment ? 'casting-row--assigned' : ''}`}
            >
              {/* Speaker info */}
              <div className="casting-row__speaker">
                <span className="casting-row__avatar">
                  {speaker.label?.slice(0, 2).toUpperCase() || 'S'}
                </span>
                <div className="casting-row__info">
                  <span className="casting-row__name">{speaker.label || speaker.id}</span>
                  <span className="casting-row__meta">
                    {t('casting.segments_count', { count: speaker.segments_count || 0 })}
                  </span>
                </div>
              </div>

              {/* Arrow */}
              <span className="casting-row__arrow">→</span>

              {/* Voice assignment dropdown */}
              <div className="casting-row__voice">
                <button
                  className="casting-row__picker"
                  onClick={() => setOpenDropdown(openDropdown === speaker.id ? null : speaker.id)}
                >
                  {assignedProfile ? (
                    <>
                      <Mic size={12} />
                      <span>{assignedProfile.name}</span>
                    </>
                  ) : (
                    <>
                      <span className="casting-row__unassigned">{t('casting.assign_voice')}</span>
                    </>
                  )}
                  <ChevronDown size={12} />
                </button>

                {/* Dropdown */}
                {openDropdown === speaker.id && (
                  <div className="casting-dropdown">
                    {/* Auto-clone options */}
                    {autoClones && Object.keys(autoClones).length > 0 && (
                      <>
                        {Object.keys(autoClones).map(spk => {
                          const autoId = `auto:${(spk || '').toLowerCase().replace(/\s+/g, '_')}`;
                          const isActiveAuto = currentAssignment === autoId;
                          return (
                            <button
                              key={autoId}
                              className={`casting-dropdown__item ${isActiveAuto ? 'is-active' : ''}`}
                              onClick={() => assign(speaker.id, autoId)}
                            >
                              <Shuffle size={11} />
                              <span>{spk}</span>
                              {isActiveAuto && <Check size={11} />}
                            </button>
                          );
                        })}
                        {profiles.length > 0 && <div className="casting-dropdown__divider" />}
                      </>
                    )}

                    {/* Saved profiles */}
                    {profiles.map(p => (
                      <button
                        key={p.id}
                        className={`casting-dropdown__item ${currentAssignment === p.id ? 'is-active' : ''}`}
                        onClick={() => assign(speaker.id, p.id)}
                      >
                        <Mic size={11} />
                        <span>{p.name}</span>
                        {p.personality && (
                          <span className="casting-dropdown__tag">{p.personality}</span>
                        )}
                        {currentAssignment === p.id && <Check size={11} />}
                      </button>
                    ))}

                    {profiles.length === 0 && !autoClones[speaker.id] && (
                        <div className="casting-dropdown__empty">
                          {t('casting.no_profiles')}
                        </div>
                    )}
                  </div>
                )}
              </div>

              {/* Preview button */}
              {currentAssignment && onPreview && (
                <button
                  className="casting-row__preview"
                  onClick={() => onPreview(currentAssignment)}
                  title={t('casting.preview_voice')}
                >
                  <Volume2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
