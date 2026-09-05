import { useEffect, useRef, useState } from 'react';
import { LayoutGrid, Users, UserRound, Fingerprint } from 'lucide-react';
import SearchableSelect from '../SearchableSelect';
import { PRESET_ICONS, FALLBACK_VOICE_ICON, stripVoiceEmoji } from '../../utils/voiceIcons';
import toast from 'react-hot-toast';
import { PRESETS } from '../../utils/constants';
import { autoProfileId, assignSpeakerProfile, castParts, castSpeakers } from '../../utils/segments';

// The Default voice IS the empty profile_id, but a dataTransfer payload can't
// carry '' distinguishably from "no data" — so it travels as this sentinel.
const DEFAULT_VOICE = '__default__';

/**
 * CAST — per-speaker voice assignment: the compact <select> strip
 * (pre-existing, unchanged markup) plus an expandable casting board —
 * draggable voice chips dropped onto speaker rows, with a keyboard path
 * (focus a speaker, pick from a listbox). Both views write through
 * `assignSpeakerProfile`, so a drop is byte-identical to picking the same
 * option in the dropdown — no new persistence, the job save path already carries these fields.
 */
export default function CastingBoard({ t, dubSegments, setDubSegments, speakerClones, profiles }) {
  const [boardOpen, setBoardOpen] = useState(false);
  const [dropTarget, setDropTarget] = useState(null); // speaker id under a drag
  const [pickerFor, setPickerFor] = useState(null); // speaker id with the listbox open
  const [activeIdx, setActiveIdx] = useState(0);
  const optionRefs = useRef([]);
  const rowBtnRefs = useRef({});

  // Roving focus: while a listbox is open, the active option owns focus.
  useEffect(() => {
    if (pickerFor !== null) optionRefs.current[activeIdx]?.focus();
  }, [pickerFor, activeIdx]);
  const speakers = castSpeakers(dubSegments);
  if (!speakers.length) return null;

  const currentVoice = (spk) =>
    dubSegments.find((s) => s.speaker_id === spk)?.profile_id ||
    dubSegments.flatMap(castParts).find((part) => part.speaker_id === spk)?.profile_id ||
    '';

  const voiceLabel = (val, spk) => {
    if (!val) return t('dub.default');
    const clone = speakerClones[spk];
    if (clone && val === autoProfileId(spk)) {
      return t('dub.from_video', { duration: clone.duration.toFixed(1) });
    }
    if (val.startsWith('preset:')) {
      return PRESETS.find((p) => p.id === val.replace('preset:', ''))?.name || val;
    }
    return profiles.find((p) => p.id === val)?.name || val;
  };

  // Per-speaker option list — the exact choices the <select> offers, in the
  // same order (auto-clone first when available, then Default, then saved
  // clone profiles, then design presets).
  const voiceOptions = (spk) => {
    const clone = speakerClones[spk];
    const auto = clone
      ? [
          {
            value: autoProfileId(spk),
            label: t('dub.from_video', { duration: clone.duration.toFixed(1) }),
          },
        ]
      : [];
    return [
      ...auto,
      { value: '', label: t('dub.default') },
      ...profiles.map((p) => ({ value: p.id, label: p.name })),
      ...PRESETS.map((p) => ({ value: `preset:${p.id}`, label: p.name })),
    ];
  };

  const assign = (spk, val) => {
    setDubSegments(assignSpeakerProfile(dubSegments, spk, val));
    toast.success(t('dub.casting_assigned', { voice: voiceLabel(val, spk), speaker: spk }));
  };

  const closePicker = (refocus = true) => {
    const spk = pickerFor;
    setPickerFor(null);
    setActiveIdx(0);
    if (refocus && spk !== null) rowBtnRefs.current[spk]?.focus();
  };

  const onListboxKeyDown = (e, spk, options) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIdx(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      assign(spk, options[activeIdx].value);
      closePicker();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    } else if (e.key === 'Tab') {
      // Let the browser move focus forward/backward. Refocusing the trigger
      // here traps keyboard users inside the picker.
      closePicker(false);
    }
  };

  const onDrop = (e, spk) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer?.getData('text/plain');
    if (!raw) return;
    const value = raw === DEFAULT_VOICE ? '' : raw;
    if (!voiceOptions(spk).some((option) => option.value === value)) return;
    assign(spk, value);
  };

  // Speaker-independent palette (the auto-clone chip lives on its row).
  const paletteChips = [
    { value: '', label: t('dub.default'), group: '' },
    ...profiles.map((p) => ({ value: p.id, label: p.name, group: t('dub.clone_profiles') })),
    ...PRESETS.map((p) => ({
      value: `preset:${p.id}`,
      label: p.name,
      group: t('dub.design_presets'),
    })),
  ];

  return (
    <div className="dub-casting-controls my-3 p-4 bg-[var(--chrome-hover-bg)] rounded-lg border-0">
      <div className="flex gap-[var(--space-2)] items-center flex-wrap">
        <span
          className="font-[family-name:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] text-[var(--chrome-fg-muted)] tracking-[var(--chrome-label-track)] uppercase font-semibold"
          title={t('dub.cast_title')}
        >
          <Users size={16} aria-hidden="true" className="inline-block mr-2 align-text-bottom" />
          {t('dub.cast')}
        </span>
        {speakers.map((spk) => {
          const clone = speakerClones[spk];
          return (
            <div key={spk} className="dub-cast__pair">
              <span className="font-[family-name:var(--chrome-font-mono)] text-[0.62rem] text-[var(--chrome-fg)]">
                <UserRound
                  size={14}
                  aria-hidden="true"
                  className="inline-block mr-1 align-text-bottom"
                />
                {spk}
              </span>
              <SearchableSelect
                ariaLabel={spk}
                menuPortal
                renderGroupHeaders
                buttonClassName="dub-cast__select min-h-10 rounded-lg border-0 bg-[var(--chrome-hover-bg)] px-3 py-2 text-sm text-[var(--chrome-fg)] hover:bg-[var(--chrome-accent-bg)] focus-visible:outline-2 focus-visible:outline-[var(--chrome-accent)]"
                value={currentVoice(spk)}
                onChange={(value) => setDubSegments(assignSpeakerProfile(dubSegments, spk, value))}
                options={[
                  ...(clone
                    ? [
                        {
                          value: autoProfileId(spk),
                          label: t('dub.from_video', { duration: clone.duration.toFixed(1) }),
                          Icon: UserRound,
                        },
                      ]
                    : []),
                  { value: '', label: t('dub.default'), Icon: UserRound },
                  ...profiles.map((p) => ({
                    value: p.id,
                    label: p.name,
                    group: 'clones',
                    groupLabel: t('dub.clone_profiles'),
                    Icon: Fingerprint,
                  })),
                  ...PRESETS.map((p) => ({
                    value: 'preset:' + p.id,
                    label: stripVoiceEmoji(p.name),
                    group: 'presets',
                    groupLabel: t('dub.design_presets'),
                    Icon: PRESET_ICONS[p.id] || FALLBACK_VOICE_ICON,
                  })),
                ]}
                renderOption={(option) => {
                  const Icon = option.Icon;
                  return (
                    <span className="inline-flex items-center gap-2">
                      <Icon size={16} aria-hidden="true" className="shrink-0 opacity-75" />
                      <span>{option.label}</span>
                    </span>
                  );
                }}
              />
            </div>
          );
        })}
        <button
          type="button"
          className={`dub-cast__board-toggle ${boardOpen ? 'is-open' : ''}`}
          aria-expanded={boardOpen}
          onClick={() => setBoardOpen((o) => !o)}
          title={t('dub.casting_board_hint')}
        >
          <LayoutGrid size={10} /> {t('dub.casting_board')}
        </button>
      </div>

      {boardOpen && (
        <div className="dub-cast__board" data-testid="casting-board">
          <div className="dub-cast__palette" role="list" aria-label={t('dub.casting_voices')}>
            {paletteChips.map((chip) => (
              <span
                key={chip.value || DEFAULT_VOICE}
                role="listitem"
                className="dub-cast__chip"
                draggable
                data-profile={chip.value}
                title={chip.group ? `${chip.group} · ${chip.label}` : chip.label}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', chip.value || DEFAULT_VOICE);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                {chip.label}
              </span>
            ))}
          </div>
          <p className="dub-cast__hint">{t('dub.casting_drag_hint')}</p>
          <div className="dub-cast__rows">
            {speakers.map((spk) => {
              const clone = speakerClones[spk];
              const options = voiceOptions(spk);
              const current = currentVoice(spk);
              return (
                <div
                  key={spk}
                  className={`dub-cast__row ${dropTarget === spk ? 'is-drop' : ''}`}
                  data-speaker={spk}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragEnter={() => setDropTarget(spk)}
                  onDragLeave={(e) => {
                    if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) {
                      setDropTarget((cur) => (cur === spk ? null : cur));
                    }
                  }}
                  onDrop={(e) => onDrop(e, spk)}
                >
                  <button
                    type="button"
                    ref={(el) => {
                      rowBtnRefs.current[spk] = el;
                    }}
                    className="dub-cast__row-btn"
                    aria-haspopup="listbox"
                    aria-expanded={pickerFor === spk}
                    aria-label={t('dub.casting_assign_to', { speaker: spk })}
                    title={t('dub.casting_assign_to', { speaker: spk })}
                    onClick={() => {
                      if (pickerFor === spk) {
                        closePicker();
                        return;
                      }
                      optionRefs.current = [];
                      const idx = options.findIndex((o) => o.value === current);
                      setActiveIdx(idx >= 0 ? idx : 0);
                      setPickerFor(spk);
                    }}
                  >
                    <span className="dub-cast__row-speaker">{spk}</span>
                    <span className="dub-cast__row-voice">{voiceLabel(current, spk)}</span>
                  </button>
                  {clone && (
                    <span
                      className="dub-cast__auto-chip"
                      title={t('dub.from_video', { duration: clone.duration.toFixed(1) })}
                    >
                      {t('dub.from_video', { duration: clone.duration.toFixed(1) })}
                    </span>
                  )}
                  {pickerFor === spk && (
                    <div
                      className="dub-cast__listbox"
                      role="listbox"
                      aria-label={t('dub.casting_assign_to', { speaker: spk })}
                      onKeyDown={(e) => onListboxKeyDown(e, spk, options)}
                    >
                      {options.map((opt, i) => (
                        <button
                          type="button"
                          key={opt.value || DEFAULT_VOICE}
                          ref={(el) => {
                            optionRefs.current[i] = el;
                          }}
                          role="option"
                          aria-selected={opt.value === current}
                          tabIndex={i === activeIdx ? 0 : -1}
                          className={`dub-cast__option ${opt.value === current ? 'is-current' : ''}`}
                          onClick={() => {
                            assign(spk, opt.value);
                            closePicker();
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
