import React from 'react';
import { useTranslation } from 'react-i18next';
import { Command, X } from 'lucide-react';
import './KeyboardCheatsheet.css';

const SECTION_KEYS = [
  {
    titleKey: 'components.navigation_section',
    items: [
      ['?', 'components.show_cheatsheet'],
      ['Esc', 'components.close_modal'],
      ['Cmd/Ctrl+S', 'components.save_project'],
    ],
  },
  {
    titleKey: 'components.segment_editor_section',
    items: [
      ['Cmd/Ctrl+D', 'components.split_segment'],
      ['Cmd/Ctrl+M', 'components.merge_segment'],
      ['Cmd/Ctrl+Z', 'components.undo'],
      ['Cmd/Ctrl+Shift+Z', 'components.redo'],
      ['Click row', 'components.primary_action'],
      ['Shift+click row', 'components.range_select'],
    ],
  },
  {
    titleKey: 'components.audio_trimmer_section',
    items: [
      ['Space', 'components.preview_play'],
      ['← / →', 'components.nudge_start'],
      ['Ctrl+← / →', 'components.nudge_end'],
      ['Shift+arrow', 'components.fine_nudge'],
      ['Alt+arrow', 'components.coarse_nudge'],
      ['+ / −', 'components.zoom_in_out'],
      ['Home / End', 'components.fit_all_fit_sel'],
      ['Enter', 'components.confirm_trim'],
    ],
  },
  {
    titleKey: 'components.dub_section',
    items: [
      ['Cmd/Ctrl+Enter', 'components.generate_dub_shortcut'],
      ['Cmd/Ctrl+B', 'components.toggle_sidebar_shortcut'],
    ],
  },
];

function Kbd({ children }) {
  return <span className="kcs-kbd">{children}</span>;
}

export default function KeyboardCheatsheet({ open, onClose }) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <div onClick={onClose} className="kcs-overlay">
      <div onClick={(e) => e.stopPropagation()} className="kcs-panel">
        <div className="kcs-header">
          <div className="kcs-header__left">
            <Command size={16} color="var(--chrome-accent)" />
            <h2 className="kcs-title">{t('components.keyboard_shortcuts')}</h2>
          </div>
          <button onClick={onClose} className="kcs-close">
            <X size={16} />
          </button>
        </div>

        <div className="kcs-grid">
          {SECTION_KEYS.map((sec) => (
            <div key={sec.titleKey}>
              <div className="kcs-section-title">{t(sec.titleKey)}</div>
              <div className="kcs-items">
                {sec.items.map(([keys, descKey]) => (
                  <div key={keys} className="kcs-row">
                    <span className="kcs-desc">{t(descKey)}</span>
                    <span className="kcs-keys">
                      {keys.split(' / ').map((group, i, arr) => (
                        <React.Fragment key={group}>
                          <span className="kcs-key-group">
                            {group.split('+').map((k) => <Kbd key={k}>{k}</Kbd>)}
                          </span>
                          {i < arr.length - 1 && <span className="kcs-or">{t('components.or_separator')}</span>}
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="kcs-footer">
          {t('components.press_question')}
        </div>
      </div>
    </div>
  );
}
