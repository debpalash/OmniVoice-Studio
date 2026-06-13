import React, { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Scale, Fingerprint, Wand2, Film, Lock, BookOpen, BookMarked, LibraryBig,
  FileText, HardDrive, Download, ArrowRight,
} from 'lucide-react';
import { API } from '../api/client';
import { useAppStore } from '../store';
import ReadinessChecklist from '../components/ReadinessChecklist';

function DubThumb({ jobId, fallback }) {
  const [failed, setFailed] = useState(false);
  if (!jobId || failed) return fallback;
  return (
    <img
      src={`${API}/dub/thumb/${jobId}`}
      alt=""
      onError={() => setFailed(true)}
      loading="lazy"
      className="lp-dub-thumb"
    />
  );
}

// Squiggle was replaced by the .lp-hero__sweep span — a pure-CSS animated
// accent line under the H1. Less static, no SVG dependency.

/**
 * ActionCard — the three big Launchpad tiles. Reads its accent from a
 * single `--card-hue` var so the CSS derives background / border / glow /
 * spotlight from one hex color. Cursor-tracking spotlight: pointer events
 * set --mx/--my so `.lp-glow-layer` can paint a radial gradient at the
 * cursor position. Eternal breath ring lives on `.lp-glow-layer::after`
 * and pulses forever whether the card is hovered or not.
 */
function ActionCard({ hue, Icon, title, count, onClick, children }) {
  const handleMouseMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return (
    <button
      type="button"
      className="lp-action-card lp-animate lp-glow-card"
      onClick={onClick}
      onMouseMove={handleMouseMove}
      style={{ '--card-hue': hue }}
    >
      <span className="lp-glow-layer" aria-hidden="true" />
      {count > 0 && <span className="card-count">{count}</span>}
      <div className="card-icon">
        <Icon size={18} color={hue} />
      </div>
      <h3>{title}</h3>
      <p className="card-desc">{children}</p>
    </button>
  );
}

export default function Launchpad({
  profiles, studioProjects, dubHistory, exportHistory = [],
  setMode, setIsCompareModalOpen, handleSelectProfile, loadProject,
}) {
  const { t } = useTranslation();
  // Clone/Design are no longer separate navigation modes — both cards open
  // the unified Voice ('studio') workspace preset to the matching method.
  const setDefineMethod = useAppStore(s => s.setDefineMethod);
  const openStudio = (method) => { setMode('studio'); setDefineMethod(method); };
  const cloneProfiles = profiles.filter(p => !p.instruct);
  const designProfiles = profiles.filter(p => !!p.instruct);
  const demoProfile = profiles.find(p => p.id === 'demo0001');
  // Most-recent exported files from OmniDrive — a quick "pick up where you left
  // off" strip. exportHistory arrives newest-first from /export/history.
  const recentFiles = exportHistory.slice(0, 4);

  return (
    <div className="launchpad">
      {/* Ambient backdrop — chrome-accent aurora that drifts forever. Lives
          behind everything at z=0, contributes the "eternal glow" the user
          asked for without painting any one surface. */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      {/* Hero */}
      <div className="lp-hero">
        <div className="lp-hero__row">
          <div className="lp-hero__col">
            <div className="lp-hero__kicker-row">
              <div className="lp-hero__wave-group">
                {[10, 14, 8, 16, 12, 14, 9, 12].map((h, i) => (
                  <span
                    key={i}
                    className="lp-wave-bar"
                    style={{
                      // Per-bar animation offsets + distinct durations give
                      // a breathing, never-identical pulse instead of the
                      // rigid uniform bounce the old version had.
                      '--bar-h': `${h}px`,
                      '--bar-delay': `${i * 0.17}s`,
                      '--bar-dur':   `${1.8 + (i % 3) * 0.4}s`,
                    }}
                  />
                ))}
              </div>
              <span className="lp-kicker">{t('launchpad.greeting')}</span>
            </div>
            <h1 className="lp-hero__title">
              <span className="lp-hero__halo" aria-hidden="true" />
              <Trans i18nKey="launchpad.hero_title" components={{ 1: <em /> }} />
              <span className="lp-hero__sweep" aria-hidden="true" />
            </h1>
            <p>
              <Trans i18nKey="launchpad.hero_desc" values={{ count: 646 }} components={{ 1: <span className="lp-pill" /> }} />
            </p>
          </div>
          {/* A/B Compare is a side-by-side voice diff — only useful when the
              user has at least two profiles to actually compare. On a fresh
              install (or for first-time users) the button is just chrome
              noise that opens an empty modal, so we gate it. */}
          {profiles.length >= 2 && (
            <button
              onClick={() => setIsCompareModalOpen(true)}
              className="lp-ab-compare"
              title={t('launchpad.ab_compare_title')}
            >
              <Scale size={12} /> {t('launchpad.ab_compare')}
            </button>
          )}
        </div>

      </div>

      {/* Action Cards */}
      <div className="lp-actions">
        <ActionCard hue="#d3869b" Icon={Fingerprint} title={t('launchpad.clone_title')} count={cloneProfiles.length} onClick={() => openStudio('audio')}>
          {t('launchpad.clone_desc')}
        </ActionCard>
        <ActionCard hue="#8ec07c" Icon={Wand2} title={t('launchpad.design_title')} count={designProfiles.length} onClick={() => openStudio('design')}>
          {t('launchpad.design_desc')}
        </ActionCard>
        <ActionCard hue="#fe8019" Icon={Film} title={t('launchpad.dub_title')} count={studioProjects.length} onClick={() => setMode('dub')}>
          {t('launchpad.dub_desc')}
        </ActionCard>
        <ActionCard hue="#83a598" Icon={BookOpen} title={t('launchpad.stories_title')} onClick={() => setMode('stories')}>
          {t('launchpad.stories_desc')}
        </ActionCard>
        <ActionCard hue="#458588" Icon={BookMarked} title={t('launchpad.audiobook_title')} onClick={() => setMode('audiobook')}>
          {t('launchpad.audiobook_desc')}
        </ActionCard>
        <ActionCard hue="#fabd2f" Icon={LibraryBig} title={t('launchpad.gallery_title')} onClick={() => setMode('gallery')}>
          {t('launchpad.gallery_desc')}
        </ActionCard>
        <ActionCard hue="#b8bb26" Icon={FileText} title={t('launchpad.transcripts_title')} onClick={() => setMode('transcriptions')}>
          {t('launchpad.transcripts_desc')}
        </ActionCard>
      </div>

      {/* Recent files from OmniDrive — last few exports, with a jump to the
          full file browser (the Projects/OmniDrive page). */}
      {recentFiles.length > 0 && (
        <div className="lp-section lp-files">
          <div className="lp-files__head">
            <div className="lp-section-title"><HardDrive size={12} color="#fabd2f" /> {t('launchpad.recent_files')}</div>
            <button type="button" className="lp-view-all" onClick={() => setMode('projects')}>
              {t('launchpad.view_all_files')} <ArrowRight size={12} />
            </button>
          </div>
          <div className="lp-files__grid">
            {recentFiles.map((f, i) => {
              const name = (f.destination_path || f.path || f.filename || '').split('/').pop() || t('launchpad.file');
              return (
                <button
                  key={f.id || f.destination_path || i}
                  type="button"
                  className="lp-project-card lp-file-card"
                  onClick={() => setMode('projects')}
                  title={name}
                >
                  <div className="proj-icon lp-proj-icon--file"><Download size={14} color="#fabd2f" /></div>
                  <div className="proj-info">
                    <div className="proj-name">{name}</div>
                    {f.mode && <div className="proj-meta">{f.mode}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Demo profile callout */}
      {demoProfile && profiles.length === 1 && studioProjects.length === 0 && (
        <div className="lp-demo-callout">
          <span className="lp-demo-callout__icon">👋</span>
          <span>{t('launchpad.demo_callout')}</span>
          <button
            className="lp-demo-callout__btn"
            onClick={() => { openStudio('audio'); handleSelectProfile(demoProfile); }}
          >
            {t('launchpad.try_it')}
          </button>
        </div>
      )}

      {/* Recent Projects */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <div className="lp-section">
          <div className="lp-section__grid">
            {/* Cloned voices */}
            {cloneProfiles.length > 0 && (
              <div>
                <div className="lp-section-title"><Fingerprint size={12} color="#d3869b" /> {t('launchpad.cloned_voices')}</div>
                <div className="lp-col">
                  {cloneProfiles.map(p => (
                    <div key={p.id} className="lp-project-card">
                      <div className="proj-icon lp-proj-icon--clone"><Fingerprint size={14} color="#d3869b" /></div>
                      <div className="proj-info">
                        <div className="proj-name">{p.name}</div>
                        <div className="proj-meta">{p.ref_audio_path}</div>
                      </div>
                      <button className="proj-action" onClick={() => { openStudio('audio'); handleSelectProfile(p); }}>{t('launchpad.open')}</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Designed voices */}
            {designProfiles.length > 0 && (
              <div>
                <div className="lp-section-title"><Wand2 size={12} color="#8ec07c" /> {t('launchpad.designed_voices')}</div>
                <div className="lp-col">
                  {designProfiles.map(p => (
                    <div key={p.id} className="lp-project-card">
                      <div className={`proj-icon ${p.is_locked ? 'lp-proj-icon--locked' : 'lp-proj-icon--design'}`}>
                        {p.is_locked ? <Lock size={14} color="#b8bb26" /> : <Wand2 size={14} color="#8ec07c" />}
                      </div>
                      <div className="proj-info">
                        <div className="proj-name">{p.name}</div>
                        <div className="proj-meta lp-proj-meta--italic">{p.instruct}</div>
                      </div>
                      {p.is_locked && <span className="lp-locked-badge">{t('launchpad.locked')}</span>}
                      <button className="proj-action" onClick={() => { openStudio('design'); handleSelectProfile(p); }}>{t('launchpad.open')}</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dubbing projects */}
            {studioProjects.length > 0 && (
              <div>
                <div className="lp-section-title"><Film size={12} color="#fe8019" /> {t('launchpad.dubbing_projects')}</div>
                <div className="lp-col">
                  {studioProjects.map(proj => (
                    <div key={proj.id} className="lp-project-card">
                      <div className="proj-icon lp-proj-icon--dub">
                        <DubThumb
                          jobId={proj.state?.dubJobId || proj.id}
                          fallback={<Film size={14} color="#fe8019" />}
                        />
                      </div>
                      <div className="proj-info">
                        <div className="proj-name">{proj.name}</div>
                        <div className="proj-meta">{proj.video_path || t('launchpad.audio_only')}</div>
                      </div>
                      <button className="proj-action" onClick={() => { setMode('dub'); loadProject(proj.id); }}>{t('launchpad.open')}</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {profiles.length === 0 && studioProjects.length === 0 && (
        <div className="lp-empty">
          <div className="lp-empty__inner">
            <div className="lp-empty__bars">
              {[8, 14, 22, 18, 26, 14, 20, 10, 16].map((h, i) => (
                <span
                  key={i}
                  className="lp-wave-bar"
                  style={{
                    height: h, background: '#665c54', animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </div>
            <p className="lp-empty__hint">
              {t('launchpad.empty_hint')}
            </p>
          </div>
          {/* No `showWhenAllPass` — let the component self-hide when every
              check is pass-or-warn. Surfacing "everything is fine" on the
              welcome screen is noise; only show when there's an actual
              issue to address. */}
          <ReadinessChecklist />
        </div>
      )}

      {/* Show checklist alongside existing projects too, but only when issues exist */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <ReadinessChecklist compact />
      )}
    </div>
  );
}
