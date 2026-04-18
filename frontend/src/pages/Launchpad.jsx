import React, { useState } from 'react';
import {
  Scale, Fingerprint, Wand2, Film, Lock,
} from 'lucide-react';
import { API } from '../api/client';

function DubThumb({ jobId, fallback }) {
  const [failed, setFailed] = useState(false);
  if (!jobId || failed) return fallback;
  return (
    <img
      src={`${API}/dub/thumb/${jobId}`}
      alt=""
      onError={() => setFailed(true)}
      loading="lazy"
      style={{
        width: '100%', height: '100%', objectFit: 'cover',
        borderRadius: 'inherit', display: 'block',
      }}
    />
  );
}

const Squiggle = () => (
  <svg className="lp-underline" viewBox="0 0 240 8" preserveAspectRatio="none" aria-hidden="true">
    <path
      d="M2 5 Q 20 1 40 4 T 80 4 T 120 3 T 160 5 T 200 3 T 238 4"
      stroke="#f3a5b6"
      strokeWidth="2.5"
      fill="none"
      strokeLinecap="round"
    />
  </svg>
);

export default function Launchpad({
  profiles, studioProjects, dubHistory,
  setMode, setIsCompareModalOpen, handleSelectProfile, loadProject,
}) {
  const cloneProfiles = profiles.filter(p => !p.instruct);
  const designProfiles = profiles.filter(p => !!p.instruct);

  return (
    <div className="launchpad">
      {/* Hero */}
      <div className="lp-hero">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
          <div style={{ maxWidth: 640 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '2px', height: '24px' }}>
                {[14, 20, 10, 24, 16, 22, 12, 18].map((h, i) => (
                  <span
                    key={i}
                    className="lp-wave-bar"
                    style={{
                      height: h,
                      background: 'linear-gradient(to top, #f3a5b6, #fabd2f)',
                      animationDelay: `${i * 0.15}s`,
                      opacity: 0.7 + (i % 3) * 0.1,
                      borderRadius: 4,
                    }}
                  />
                ))}
              </div>
              <span style={{ fontFamily: 'Nunito, sans-serif', fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#7c6f64' }}>
                hello there 👋
              </span>
            </div>
            <h1>
              Make voices that <em>sound like you</em>.
              <Squiggle />
            </h1>
            <p>
              Clone a voice, design a new one, or dub a video into any of <span className="lp-pill">646 languages</span>.
              Built for creators who care how it sounds. 🎧
            </p>
          </div>
          <button
            className="btn-primary"
            onClick={() => setIsCompareModalOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 18px', fontSize: '0.78rem', width: 'auto', marginTop: 8,
              borderRadius: '999px',
              fontFamily: 'Nunito, sans-serif', fontWeight: 800,
              flexShrink: 0, transform: 'rotate(1deg)',
            }}
            title="Try two voices side by side"
          >
            <Scale size={14} /> A/B Compare
          </button>
        </div>

      </div>

      {/* Action Cards */}
      <div className="lp-actions">
        <div
          className="lp-action-card lp-animate"
          onClick={() => setMode('clone')}
          style={{ '--card-accent': 'rgba(211,134,155,0.1)', '--card-border': 'rgba(211,134,155,0.25)' }}
        >
          {cloneProfiles.length > 0 && <span className="card-count" style={{ background: 'rgba(211,134,155,0.12)', color: '#d3869b' }}>{cloneProfiles.length}</span>}
          <div className="card-icon" style={{ background: 'rgba(211,134,155,0.1)' }}>
            <Fingerprint size={18} color="#d3869b" />
          </div>
          <h3>Voice Clone ✨</h3>
          <p className="card-desc">Drop in a short clip — we'll mirror it. One sample is usually enough.</p>
        </div>

        <div
          className="lp-action-card lp-animate"
          onClick={() => setMode('design')}
          style={{ '--card-accent': 'rgba(142,192,124,0.1)', '--card-border': 'rgba(142,192,124,0.25)' }}
        >
          {designProfiles.length > 0 && <span className="card-count" style={{ background: 'rgba(142,192,124,0.12)', color: '#8ec07c' }}>{designProfiles.length}</span>}
          <div className="card-icon" style={{ background: 'rgba(142,192,124,0.1)' }}>
            <Wand2 size={18} color="#8ec07c" />
          </div>
          <h3>Voice Design 🧪</h3>
          <p className="card-desc">Build a new voice from a sentence. Gender, age, accent, mood — your call.</p>
        </div>

        <div
          className="lp-action-card lp-animate"
          onClick={() => setMode('dub')}
          style={{ '--card-accent': 'rgba(254,128,25,0.1)', '--card-border': 'rgba(254,128,25,0.25)' }}
        >
          {studioProjects.length > 0 && <span className="card-count" style={{ background: 'rgba(254,128,25,0.12)', color: '#fe8019' }}>{studioProjects.length}</span>}
          <div className="card-icon" style={{ background: 'rgba(254,128,25,0.1)' }}>
            <Film size={18} color="#fe8019" />
          </div>
          <h3>Video Dubbing 🎬</h3>
          <p className="card-desc">Transcribe, translate, re-voice. Keep each speaker, line up the timing, ship it.</p>
        </div>
      </div>

      {/* Recent Projects */}
      {(profiles.length > 0 || studioProjects.length > 0) && (
        <div className="lp-section">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px' }}>
            {/* Cloned voices */}
            {cloneProfiles.length > 0 && (
              <div>
                <div className="lp-section-title"><Fingerprint size={12} color="#d3869b" /> Cloned Voices</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {cloneProfiles.map(p => (
                    <div key={p.id} className="lp-project-card">
                      <div className="proj-icon" style={{ background: 'rgba(211,134,155,0.1)' }}><Fingerprint size={14} color="#d3869b" /></div>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {designProfiles.map(p => (
                    <div key={p.id} className="lp-project-card">
                      <div className="proj-icon" style={{ background: p.is_locked ? 'rgba(184,187,38,0.1)' : 'rgba(142,192,124,0.1)' }}>
                        {p.is_locked ? <Lock size={14} color="#b8bb26" /> : <Wand2 size={14} color="#8ec07c" />}
                      </div>
                      <div className="proj-info">
                        <div className="proj-name">{p.name}</div>
                        <div className="proj-meta" style={{ fontStyle: 'italic' }}>{p.instruct}</div>
                      </div>
                      {p.is_locked && <span style={{ fontSize: '0.5rem', padding: '1px 6px', borderRadius: 4, background: 'rgba(184,187,38,0.12)', color: '#b8bb26', fontWeight: 600 }}>LOCKED</span>}
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {studioProjects.map(proj => (
                    <div key={proj.id} className="lp-project-card">
                      <div className="proj-icon" style={{ background: 'rgba(254,128,25,0.1)', overflow: 'hidden' }}>
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
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
          <div style={{ textAlign: 'center', maxWidth: 360 }}>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '3px', marginBottom: '16px', opacity: 0.3 }}>
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
            <p style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '1rem', color: '#a89984', margin: 0, fontStyle: 'italic' }}>
              Nothing here yet. Pick a card above — we'll wait. ☕
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
