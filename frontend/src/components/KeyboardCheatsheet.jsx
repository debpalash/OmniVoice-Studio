import React from 'react';
import { Command, X } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import './KeyboardCheatsheet.css';

function Kbd({ children }) {
  return <span className="kcs-kbd">{children}</span>;
}

export default function KeyboardCheatsheet({ open, onClose }) {
  const { t } = useTranslation();

  const SECTIONS = [
    {
      title: t('keyboard.nav'),
      items: [
        ['?', t('keyboard.nav_cheatsheet')],
        ['Esc', t('keyboard.nav_closeModal')],
        ['Cmd/Ctrl+S', t('keyboard.nav_save')],
      ],
    },
    {
      title: t('keyboard.segmentEditor'),
      items: [
        ['Cmd/Ctrl+D', t('keyboard.seg_split')],
        ['Cmd/Ctrl+M', t('keyboard.seg_merge')],
        ['Cmd/Ctrl+Z', t('keyboard.seg_undo')],
        ['Cmd/Ctrl+Shift+Z', t('keyboard.seg_redo')],
        ['Click row', t('keyboard.seg_click')],
        ['Shift+click row', t('keyboard.seg_shiftClick')],
      ],
    },
    {
      title: t('keyboard.trimmer'),
      items: [
        ['Space', t('keyboard.trim_playPause')],
        ['← / →', t('keyboard.trim_nudgeStart')],
        ['Ctrl+← / →', t('keyboard.trim_nudgeEnd')],
        ['Shift+arrow', t('keyboard.trim_fineNudge')],
        ['Alt+arrow', t('keyboard.trim_coarseNudge')],
        ['+ / −', t('keyboard.trim_zoomIn')],
        ['Home / End', t('keyboard.trim_fitAll')],
        ['Enter', t('keyboard.trim_confirm')],
      ],
    },
    {
      title: t('keyboard.dub'),
      items: [
        ['Cmd/Ctrl+Enter', t('keyboard.dub_generate')],
        ['Cmd/Ctrl+B', t('keyboard.dub_sidebar')],
      ],
    },
  ];

  if (!open) return null;
  return (
    <div onClick={onClose} className="kcs-overlay">
      <div onClick={(e) => e.stopPropagation()} className="kcs-panel">
        <div className="kcs-header">
          <div className="kcs-header__left">
            <Command size={16} color="var(--chrome-accent)" />
            <h2 className="kcs-title">{t('keyboard.title')}</h2>
          </div>
          <button onClick={onClose} className="kcs-close">
            <X size={16} />
          </button>
        </div>

        <div className="kcs-grid">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="kcs-section-title">{sec.title}</div>
              <div className="kcs-items">
                {sec.items.map(([keys, desc]) => (
                  <div key={keys} className="kcs-row">
                    <span className="kcs-desc">{desc}</span>
                    <span className="kcs-keys">
                      {keys.split(' / ').map((group, i, arr) => (
                        <React.Fragment key={group}>
                          <span className="kcs-key-group">
                            {group.split('+').map((k) => (
                              <Kbd key={k}>{k}</Kbd>
                            ))}
                          </span>
                          {i < arr.length - 1 && <span className="kcs-or">{t('keyboard.or')}</span>}
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
          <Trans i18nKey="keyboard.footer" components={{ 1: <Kbd /> }}>
            {'Press <1>?</1> any time to open this.'}
          </Trans>
        </div>
      </div>
    </div>
  );
}
