import React, { useState } from 'react';
import {
  Scale, Fingerprint, Wand2, Film, Lock,
} from 'lucide-react';
import { API } from '../api/client';
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
function ActionCard({ hue, Icon, title, accent, count, onClick, children }) {
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
      <h3>
        {title} <span className="lp-action-card__emoji" aria-hidden="true">{accent}</span>
      </h3>
      <p className="card-desc">{children}</p>
    </button>
  );
}

export default function Launchpad({
  profiles, studioProjects, dubHistory,
  setMode, setIsCompareModalOpen, handleSelectProfile, loadProject,
}) {
  const cloneProfiles = profiles.filter(p => !p.instruct);
  const designProfiles = profiles.filter(p => !!p.instruct);

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
              <span className="lp-kicker">hello there</span>
            </div>
            <h1 className="lp-hero__title">
              <span className="lp-hero__halo" aria-hidden="true" />
              Make voices that <em>sound like you</em>.
              <span className="lp-hero__sweep" aria-hidden="true" />
            </h1>
            <p>
              Clone a voice, design a new one, or dub a video into any of <span className="lp-pill">646 languages</span>.
              Built for creators who care how it sounds.
            </p>
          </div>
          <button
            onClick={() => setIsCompareModalOpen(true)}
            className="lp-ab-compare"
            title="Try two voices side by side"
          >
            <Scale size={12} /> A/B Compare
          </button>
        </div>

      </div>

      {/* Action Cards */}
      <div className="lp-actions">
        <ActionCard hue="#d3869b" Icon={Fingerprint} title="Voice Clone" accent="✨" count={cloneProfiles.length} onClick={() => setMode('clone')}>
          Drop in a short clip — we'll mirror it. One sample is usually enough.
        </ActionCard>
        <ActionCard hue="#8ec07c" Icon={Wand2} title="Voice Design" accent="🧪" count={designProfiles.length} onClick={() => setMode('design')}>
          Build a new voice from a sentence. Gender, age, accent, mood — your call.
        </ActionCard>
        <ActionCard hue="#fe8019" Icon={Film} title="Video Dubbing" accent="🎬" count={studioProjects.length} onClick={() => setMode('dub')}>
          Transcribe, translate, re-voice. Keep each speaker, line up the timing, ship it.
        </ActionCard>
      </div>

      {/* Recent Projects */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <div className="lp-section">
          <div className="lp-section__grid">
            {/* Cloned voices */}
            {cloneProfiles.length > 0 && (
              <div>
                <div className="lp-section-title"><Fingerprint size={12} color="#d3869b" /> Cloned Voices</div>
                <div className="lp-col">
                  {cloneProfiles.map(p => (
                    <div key={p.id} className="lp-project-card">
                      <div className="proj-icon lp-proj-icon--clone"><Fingerprint size={14} color="#d3869b" /></div>
                      <div className="proj-info">
                        <div className="proj-name">{p.name}</div>
                        <div className="proj-meta">{p.ref_audio_path}</div>
                      </div>
                      <button className="proj-action" onClick={() => { setMode('clone'); handleSelectProfile(p); }}>Open</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Designed voices */}
            {designProfiles.length > 0 && (
              <div>
                <div className="lp-section-title"><Wand2 size={12} color="#8ec07c" /> Designed Voices</div>
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
                      {p.is_locked && <span className="lp-locked-badge">LOCKED</span>}
                      <button className="proj-action" onClick={() => { setMode('design'); handleSelectProfile(p); }}>Open</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dubbing projects */}
            {studioProjects.length > 0 && (
              <div>
                <div className="lp-section-title"><Film size={12} color="#fe8019" /> Dubbing Projects</div>
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
                        <div className="proj-meta">{proj.video_path || 'Audio Only'}</div>
                      </div>
                      <button className="proj-action" onClick={() => { setMode('dub'); loadProject(proj.id); }}>Open</button>
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
              Nothing here yet — pick a card above.
            </p>
          </div>
          <ReadinessChecklist showWhenAllPass />
        </div>
      )}

      {/* Show checklist alongside existing projects too, but only when issues exist */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <ReadinessChecklist compact />
      )}
    </div>
  );
}
