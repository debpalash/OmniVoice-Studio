import React, { useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  Scale,
  Fingerprint,
  Wand2,
  Film,
  Lock,
  BookOpen,
  BookMarked,
  LibraryBig,
  FileText,
  HardDrive,
  Download,
  ArrowRight,
} from 'lucide-react';
import { API } from '../api/client';
import { useAppStore } from '../store';
import ReadinessChecklist from '../components/ReadinessChecklist';
import LaunchpadDeck from '../components/LaunchpadDeck';
import useShellNarrow from '../hooks/useShellNarrow';

// Shared utility-class strings for the Launchpad project/section rows. Migrated
// from the former `.lp-project-card`/`.lp-section-title`/`.proj-*` global rules
// (P4 shadcn/Tailwind pass). Defined once here so the four card instances stay
// in lockstep; Tailwind's scanner picks the literals up from this file.
const projCard =
  'bg-[var(--chrome-bg)] border border-solid border-transparent rounded-[var(--chrome-radius-pill)] py-[10px] px-[14px] [transition:background_0.15s,border-color_0.15s] flex items-center gap-[12px] hover:bg-[var(--chrome-hover-bg)] hover:border-transparent';
const projIcon =
  'w-[32px] h-[32px] rounded-[var(--chrome-radius-pill)] flex items-center justify-center shrink-0';
const projInfo = 'flex-1 min-w-0';
const projName =
  '[font-family:var(--font-sans)] text-[0.78rem] font-semibold text-[color:var(--chrome-fg)] [letter-spacing:0.01em] whitespace-nowrap overflow-hidden text-ellipsis';
const projMeta =
  '[font-family:var(--chrome-font-mono)] text-[0.62rem] text-[color:var(--chrome-fg-dim)] mt-[2px] font-normal whitespace-nowrap overflow-hidden text-ellipsis';
const projAction =
  '[font-family:var(--font-sans)] text-[0.7rem] font-medium py-[4px] px-[12px] rounded-[var(--chrome-radius-pill)] bg-transparent border border-solid border-transparent text-[color:var(--chrome-fg-muted)] cursor-pointer [transition:background_var(--dur-fast),color_var(--dur-fast),border-color_var(--dur-fast)] shrink-0 whitespace-nowrap [letter-spacing:0.02em] hover:bg-[var(--chrome-hover-bg)] hover:text-[color:var(--chrome-fg)] hover:border-[var(--chrome-fg-muted)]';
// Section divider label ("Cloned Voices" etc.) — the trailing dotted rule lives
// on an ::after pseudo, expressed via the after: variant.
const sectionTitle =
  "[font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] font-semibold uppercase [letter-spacing:var(--chrome-label-track)] text-[color:var(--chrome-fg-muted)] m-0 mb-[12px] flex items-center gap-[8px] after:content-[''] after:flex-1 after:h-px after:[background-image:radial-gradient(circle,rgba(255,255,255,0.12)_1px,transparent_1px)] after:[background-size:6px_1px]";

function DubThumb({ jobId, fallback }) {
  const [failed, setFailed] = useState(false);
  if (!jobId || failed) return fallback;
  return (
    <img
      src={`${API}/dub/thumb/${jobId}`}
      alt=""
      onError={() => setFailed(true)}
      loading="lazy"
      className="w-full h-full object-cover [border-radius:inherit] block"
    />
  );
}

// Squiggle was replaced by the .lp-hero__sweep span — a pure-CSS animated
// accent line under the H1. Less static, no SVG dependency.

/**
 * ActionCard — the flat Launchpad tiles (narrow-shell fallback for the deck).
 * Reads its accent from a
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
  profiles,
  studioProjects,
  exportHistory = [],
  setMode,
  setIsCompareModalOpen,
  handleSelectProfile,
  loadProject,
}) {
  const { t } = useTranslation();
  // Clone/Design are no longer separate navigation modes — both cards open
  // the unified Voice ('studio') workspace preset to the matching method.
  const setDefineMethod = useAppStore((s) => s.setDefineMethod);
  const openStudio = (method) => {
    setMode('studio');
    setDefineMethod(method);
  };
  const cloneProfiles = profiles.filter((p) => !p.instruct);
  const designProfiles = profiles.filter((p) => !!p.instruct);
  const demoProfile = profiles.find((p) => p.id === 'demo0001');
  // Most-recent exported files from OmniDrive — a quick "pick up where you left
  // off" strip. exportHistory arrives newest-first from /export/history.
  const recentFiles = exportHistory.slice(0, 4);

  // The seven feature cards — single source for BOTH renderings (deck fan on
  // wide shells, flat ActionCard grid on narrow ones) so hues, i18n keys,
  // counts and navigation targets can never drift between the two branches.
  const features = [
    {
      key: 'clone',
      hue: '#d3869b',
      Icon: Fingerprint,
      title: t('launchpad.clone_title'),
      desc: t('launchpad.clone_desc'),
      count: cloneProfiles.length,
      go: () => openStudio('audio'),
    },
    {
      key: 'design',
      hue: '#8ec07c',
      Icon: Wand2,
      title: t('launchpad.design_title'),
      desc: t('launchpad.design_desc'),
      count: designProfiles.length,
      go: () => openStudio('design'),
    },
    {
      key: 'dub',
      hue: '#fe8019',
      Icon: Film,
      title: t('launchpad.dub_title'),
      desc: t('launchpad.dub_desc'),
      count: studioProjects.length,
      go: () => setMode('dub'),
    },
    {
      key: 'stories',
      hue: '#83a598',
      Icon: BookOpen,
      title: t('launchpad.stories_title'),
      desc: t('launchpad.stories_desc'),
      go: () => setMode('stories'),
    },
    {
      key: 'audiobook',
      hue: '#458588',
      Icon: BookMarked,
      title: t('launchpad.audiobook_title'),
      desc: t('launchpad.audiobook_desc'),
      go: () => setMode('audiobook'),
    },
    {
      key: 'gallery',
      hue: '#fabd2f',
      Icon: LibraryBig,
      title: t('launchpad.gallery_title'),
      desc: t('launchpad.gallery_desc'),
      go: () => setMode('gallery'),
    },
    {
      key: 'transcripts',
      hue: '#b8bb26',
      Icon: FileText,
      title: t('launchpad.transcripts_title'),
      desc: t('launchpad.transcripts_desc'),
      go: () => setMode('transcriptions'),
    },
  ];

  const rootRef = useRef(null);
  const shellNarrow = useShellNarrow(rootRef);

  return (
    <div className="launchpad" ref={rootRef}>
      {/* Ambient backdrop — chrome-accent aurora that drifts forever. Lives
          behind everything at z=0, contributes the "eternal glow" the user
          asked for without painting any one surface. */}
      <div className="lp-aurora" aria-hidden="true">
        <span className="lp-aurora__blob lp-aurora__blob--pink" />
        <span className="lp-aurora__blob lp-aurora__blob--green" />
        <span className="lp-aurora__blob lp-aurora__blob--amber" />
      </div>

      {/* Hero */}
      <div className="relative z-[1] pt-[42px] px-[44px] pb-[24px] max-[900px]:pt-[24px] max-[900px]:px-[20px] max-[900px]:pb-[16px]">
        <div className="flex justify-between items-start gap-[24px] flex-wrap">
          <div className="max-w-[640px]">
            <div className="flex items-center gap-[10px] mb-[12px]">
              <div className="flex items-center gap-[2px] h-[22px]">
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
                      '--bar-dur': `${1.8 + (i % 3) * 0.4}s`,
                    }}
                  />
                ))}
              </div>
              <span className="[font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] font-semibold [letter-spacing:var(--chrome-label-track)] uppercase text-[color:var(--chrome-fg-muted)]">
                {t('launchpad.greeting')}
              </span>
            </div>
            <h1 className="text-[2.75rem] max-[900px]:text-[1.8rem] max-[640px]:text-[1.4rem] font-normal m-0 text-[color:var(--chrome-fg)] [font-family:var(--font-serif)]! [letter-spacing:-0.02em]! [line-height:1.04] inline-block relative [font-optical-sizing:auto] px-[4px]">
              <span className="lp-hero__halo" aria-hidden="true" />
              <Trans
                i18nKey="launchpad.hero_title"
                components={{
                  1: (
                    <em className="italic font-normal text-[color:var(--chrome-accent)] relative" />
                  ),
                }}
              />
              <span className="lp-hero__sweep" aria-hidden="true" />
            </h1>
            <p className="m-0 mt-[14px] text-[color:var(--chrome-fg-muted)] text-[0.82rem] max-[900px]:text-[0.85rem] max-[640px]:text-[0.78rem] [font-family:var(--font-sans)] font-normal max-w-[560px] max-[640px]:max-w-full [line-height:1.6]">
              <Trans
                i18nKey="launchpad.hero_desc"
                values={{ count: 646 }}
                components={{
                  1: (
                    <span className="inline-block py-[1px] px-[8px] rounded-[var(--chrome-radius-pill)] bg-[var(--chrome-accent-bg)] border border-solid border-[var(--chrome-accent-border)] text-[color:var(--chrome-accent)] [font-family:var(--chrome-font-mono)] font-medium text-[0.72rem] mx-[2px] my-0" />
                  ),
                }}
              />
            </p>
          </div>
          {/* A/B Compare is a side-by-side voice diff — only useful when the
              user has at least two profiles to actually compare. On a fresh
              install (or for first-time users) the button is just chrome
              noise that opens an empty modal, so we gate it. */}
          {profiles.length >= 2 && (
            <button
              onClick={() => setIsCompareModalOpen(true)}
              className="inline-flex items-center gap-[6px] py-[6px] px-[14px] [font-family:var(--font-sans)] text-[0.72rem] font-medium [letter-spacing:0.02em] text-[color:var(--chrome-accent)] bg-[var(--chrome-accent-bg)] border border-solid border-[var(--chrome-accent-border)] rounded-[var(--chrome-radius-pill)] cursor-pointer shrink-0 [transition:background_var(--dur-fast),border-color_var(--dur-fast)] hover:bg-[color-mix(in_srgb,var(--chrome-accent)_22%,transparent)]"
              title={t('launchpad.ab_compare_title')}
            >
              <Scale size={12} /> {t('launchpad.ab_compare')}
            </button>
          )}
        </div>
      </div>

      {/* Feature cards — deck-of-cards fan on wide shells; the flat grid
          below is the narrow/mini fallback (same features, same order, same
          navigation — only the presentation degrades). */}
      {!shellNarrow ? (
        <div className="relative z-[1] py-[4px] px-[44px]">
          <LaunchpadDeck features={features} />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-[12px] py-[4px] px-[44px] relative z-[1] max-[900px]:pt-0 max-[900px]:px-[20px] max-[900px]:pb-[16px] max-[900px]:[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))] max-[640px]:grid-cols-1 max-[640px]:pt-0 max-[640px]:px-[12px] max-[640px]:pb-[12px]">
          {features.map((f) => (
            <ActionCard
              key={f.key}
              hue={f.hue}
              Icon={f.Icon}
              title={f.title}
              count={f.count}
              onClick={f.go}
            >
              {f.desc}
            </ActionCard>
          ))}
        </div>
      )}

      {/* Recent files from OmniDrive — last few exports, with a jump to the
          full file browser (the Projects/OmniDrive page). */}
      {recentFiles.length > 0 && (
        <div className="pt-[28px] px-[44px] pb-[40px] relative z-[1] max-[900px]:pt-0 max-[900px]:px-[20px] max-[900px]:pb-[24px] max-[640px]:pt-0 max-[640px]:px-[12px] max-[640px]:pb-[16px]">
          <div className="flex items-center justify-between gap-[12px] mb-[12px]">
            <div className="[font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] font-semibold uppercase [letter-spacing:var(--chrome-label-track)] text-[color:var(--chrome-fg-muted)] m-0 flex items-center gap-[8px]">
              <HardDrive size={12} color="#fabd2f" /> {t('launchpad.recent_files')}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-[5px] shrink-0 border-0 bg-transparent cursor-pointer py-[2px] px-[4px] [font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] font-semibold uppercase [letter-spacing:var(--chrome-label-track)] text-[color:var(--chrome-fg-muted)] [transition:color_0.15s_ease] hover:text-[#fabd2f]"
              onClick={() => setMode('projects')}
            >
              {t('launchpad.view_all_files')} <ArrowRight size={12} />
            </button>
          </div>
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))] gap-[8px]">
            {recentFiles.map((f, i) => {
              const name =
                (f.destination_path || f.path || f.filename || '').split('/').pop() ||
                t('launchpad.file');
              return (
                <button
                  key={f.id || f.destination_path || i}
                  type="button"
                  className={`${projCard} w-full [font:inherit] text-inherit text-left cursor-pointer`}
                  onClick={() => setMode('projects')}
                  title={name}
                >
                  <div className={`${projIcon} bg-[rgba(250,189,47,0.1)]`}>
                    <Download size={14} color="#fabd2f" />
                  </div>
                  <div className={projInfo}>
                    <div className={projName}>{name}</div>
                    {f.mode && <div className={projMeta}>{f.mode}</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Demo profile callout */}
      {demoProfile && profiles.length === 1 && studioProjects.length === 0 && (
        <div className="flex items-center gap-[10px] py-[10px] px-[18px] mt-[8px] mx-[44px] mb-0 bg-[color-mix(in_srgb,var(--chrome-accent)_8%,var(--chrome-bg))] border border-solid border-[var(--chrome-accent-border)] rounded-[var(--chrome-radius-pill)] text-[0.76rem] text-[color:var(--chrome-fg)] relative z-[1] animate-[lpFadeUp_0.5s_cubic-bezier(0.4,0,0.2,1)_both]">
          <span className="text-[1.1rem]">👋</span>
          <span>{t('launchpad.demo_callout')}</span>
          <button
            className="ml-auto py-[4px] px-[14px] [font-family:var(--font-sans)] text-[0.7rem] font-semibold rounded-[var(--chrome-radius-pill)] bg-[var(--chrome-accent-bg)] border border-solid border-[var(--chrome-accent-border)] text-[color:var(--chrome-accent)] cursor-pointer [transition:background_var(--dur-fast)] hover:bg-[color-mix(in_srgb,var(--chrome-accent)_22%,transparent)]"
            onClick={() => {
              openStudio('audio');
              handleSelectProfile(demoProfile);
            }}
          >
            {t('launchpad.try_it')}
          </button>
        </div>
      )}

      {/* Recent Projects */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <div className="pt-[28px] px-[44px] pb-[40px] relative z-[1] max-[900px]:pt-0 max-[900px]:px-[20px] max-[900px]:pb-[24px] max-[640px]:pt-0 max-[640px]:px-[12px] max-[640px]:pb-[16px]">
          <div className="grid [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))] gap-[20px]">
            {/* Cloned voices */}
            {cloneProfiles.length > 0 && (
              <div>
                <div className={sectionTitle}>
                  <Fingerprint size={12} color="#d3869b" /> {t('launchpad.cloned_voices')}
                </div>
                <div className="flex flex-col gap-[8px]">
                  {cloneProfiles.map((p) => (
                    <div key={p.id} className={projCard}>
                      <div className={`${projIcon} bg-[rgba(211,134,155,0.1)]`}>
                        <Fingerprint size={14} color="#d3869b" />
                      </div>
                      <div className={projInfo}>
                        <div className={projName}>{p.name}</div>
                        <div className={projMeta}>{p.ref_audio_path}</div>
                      </div>
                      <button
                        className={projAction}
                        onClick={() => {
                          openStudio('audio');
                          handleSelectProfile(p);
                        }}
                      >
                        {t('launchpad.open')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Designed voices */}
            {designProfiles.length > 0 && (
              <div>
                <div className={sectionTitle}>
                  <Wand2 size={12} color="#8ec07c" /> {t('launchpad.designed_voices')}
                </div>
                <div className="flex flex-col gap-[8px]">
                  {designProfiles.map((p) => (
                    <div key={p.id} className={projCard}>
                      <div
                        className={`${projIcon} ${p.is_locked ? 'bg-[rgba(184,187,38,0.1)]' : 'bg-[rgba(142,192,124,0.1)]'}`}
                      >
                        {p.is_locked ? (
                          <Lock size={14} color="#b8bb26" />
                        ) : (
                          <Wand2 size={14} color="#8ec07c" />
                        )}
                      </div>
                      <div className={projInfo}>
                        <div className={projName}>{p.name}</div>
                        <div className={`${projMeta} italic`}>{p.instruct}</div>
                      </div>
                      {p.is_locked && (
                        <span className="[font-family:var(--chrome-font-mono)] text-[length:var(--chrome-label-size)] [letter-spacing:var(--chrome-label-track)] py-[1px] px-[7px] rounded-[var(--chrome-radius-pill)] bg-[color-mix(in_srgb,#b8bb26_10%,transparent)] border border-solid border-transparent text-[#b8bb26] font-semibold">
                          {t('launchpad.locked')}
                        </span>
                      )}
                      <button
                        className={projAction}
                        onClick={() => {
                          openStudio('design');
                          handleSelectProfile(p);
                        }}
                      >
                        {t('launchpad.open')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dubbing projects */}
            {studioProjects.length > 0 && (
              <div>
                <div className={sectionTitle}>
                  <Film size={12} color="#fe8019" /> {t('launchpad.dubbing_projects')}
                </div>
                <div className="flex flex-col gap-[8px]">
                  {studioProjects.map((proj) => (
                    <div key={proj.id} className={projCard}>
                      <div className={`${projIcon} bg-[rgba(254,128,25,0.1)] overflow-hidden`}>
                        <DubThumb
                          jobId={proj.state?.dubJobId || proj.id}
                          fallback={<Film size={14} color="#fe8019" />}
                        />
                      </div>
                      <div className={projInfo}>
                        <div className={projName}>{proj.name}</div>
                        <div className={projMeta}>
                          {proj.video_path || t('launchpad.audio_only')}
                        </div>
                      </div>
                      <button
                        className={projAction}
                        onClick={() => {
                          setMode('dub');
                          loadProject(proj.id);
                        }}
                      >
                        {t('launchpad.open')}
                      </button>
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
        <div className="flex-1 flex items-center justify-center relative z-[1]">
          <div className="text-center max-w-[360px]">
            <div className="flex justify-center gap-[3px] mb-[16px] opacity-30">
              {[8, 14, 22, 18, 26, 14, 20, 10, 16].map((h, i) => (
                <span
                  key={i}
                  className="lp-wave-bar"
                  style={{
                    height: h,
                    background: '#665c54',
                    animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </div>
            <p className="[font-family:var(--chrome-font-mono)] text-[0.8rem] text-[color:var(--chrome-fg-muted)] m-0">
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
      {(profiles.length > 0 || studioProjects.length > 0) && <ReadinessChecklist compact />}
    </div>
  );
}
