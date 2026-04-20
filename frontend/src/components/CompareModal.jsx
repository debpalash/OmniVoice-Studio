import React from 'react';
import { Scale, Fingerprint, Loader, Play } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { PRESETS } from '../utils/constants';
import { generateSpeech } from '../api/generate';

export default function CompareModal({
  open, onClose,
  profiles,
  compareText, setCompareText,
  compareVoiceA, setCompareVoiceA,
  compareVoiceB, setCompareVoiceB,
  compareResultA, setCompareResultA,
  compareResultB, setCompareResultB,
  compareProgress, setCompareProgress,
  isComparing, setIsComparing,
  steps, cfg, speed, denoise, postprocess,
  fileToMediaUrl, loadHistory,
}) {
  if (!open) return null;

  const runCompare = async () => {
    setIsComparing(true);
    setCompareResultA(null);
    setCompareResultB(null);

    const generateVoice = async (voiceId) => {
      setCompareProgress('Preparing voice...');
      const formData = new FormData();
      formData.append('text', compareText);
      let fin_prof = voiceId;
      let fin_inst = '';
      if (fin_prof.startsWith('preset:')) {
        const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
        if (pr) {
          const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
          fin_inst = parts.join(', ');
        }
        fin_prof = '';
      } else if (profiles.find(p => p.id === fin_prof)?.instruct) {
        fin_inst = profiles.find(p => p.id === fin_prof).instruct;
      }
      if (fin_prof) formData.append('profile_id', fin_prof);
      if (fin_inst) formData.append('instruct', fin_inst);
      formData.append('num_step', steps);
      formData.append('guidance_scale', cfg);
      formData.append('speed', speed);
      formData.append('denoise', denoise);
      formData.append('postprocess_output', postprocess);
      const res = await generateSpeech(formData);
      const blob = await res.blob();
      const urls = await fileToMediaUrl(blob, null);
      return urls.audioUrl;
    };

    try {
      setCompareProgress('Generating Voice A...');
      const audioA = await generateVoice(compareVoiceA);
      setCompareResultA(audioA);
      setCompareProgress('Generating Voice B...');
      const audioB = await generateVoice(compareVoiceB);
      setCompareResultB(audioB);
      setCompareProgress('');
      toast.success('Comparison complete!');
      loadHistory();
    } catch (err) {
      toast.error('Play failed: ' + err.message);
      setCompareProgress('');
    } finally {
      setIsComparing(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div className="glass-panel" style={{
        width: 620, maxWidth: '90vw', padding: '24px',
        display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative',
        borderRadius: '18px 22px 16px 24px / 20px 16px 22px 18px',
        border: '1px solid rgba(243,165,182,0.2)',
        boxShadow: '0 22px 50px -18px rgba(0,0,0,0.6), 0 0 0 1px rgba(243,165,182,0.08)',
      }}>
        <h2 style={{ margin: 0, color: '#ebdbb2', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '1.2rem' }}>
          <Scale /> A/B Voice Comparison
        </h2>
        <p style={{ margin: 0, fontSize: '0.85rem', color: '#a89984' }}>Compare two voices side by side to make casting decisions.</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: '0.75rem', color: '#a89984', fontWeight: 600 }}>Test Phrase</label>
          <textarea className="input-base" value={compareText} onChange={e => setCompareText(e.target.value)} rows={2} style={{ resize: 'none' }} />
        </div>

        <div className="compare-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, background: 'rgba(255,255,255,0.01)' }}>
            <h3 style={{ margin: 0, color: '#d3869b', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Fingerprint size={14} /> Voice A</h3>
            <select className="input-base" value={compareVoiceA} onChange={e => setCompareVoiceA(e.target.value)}>
              <option value="">-- Select Voice --</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} (Preset)</option>)}
            </select>
            {compareResultA ? (
              <audio src={compareResultA} controls style={{ width: '100%', height: 32, outline: 'none' }} />
            ) : (
              <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#665c54', fontSize: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>No Audio</div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8, background: 'rgba(255,255,255,0.01)' }}>
            <h3 style={{ margin: 0, color: '#8ec07c', fontSize: '0.9rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}><Fingerprint size={14} /> Voice B</h3>
            <select className="input-base" value={compareVoiceB} onChange={e => setCompareVoiceB(e.target.value)}>
              <option value="">-- Select Voice --</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} (Preset)</option>)}
            </select>
            {compareResultB ? (
              <audio src={compareResultB} controls style={{ width: '100%', height: 32, outline: 'none' }} />
            ) : (
              <div style={{ height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#665c54', fontSize: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: 4 }}>No Audio</div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
          <button className="btn-primary" style={{ background: 'transparent', color: '#a89984', padding: '6px 14px' }} onClick={onClose}>
            Close
          </button>
          <button
            className="btn-primary"
            disabled={isComparing || !compareVoiceA || !compareVoiceB || !compareText.trim()}
            onClick={runCompare}
            style={{ padding: '6px 14px', width: 200, display: 'flex', justifyContent: 'center', alignItems: 'center' }}
          >
            {isComparing ? <><Loader className="spinner" size={14} /> {compareProgress}</> : <><Play size={14} /> Compare</>}
          </button>
        </div>
      </div>
    </div>
  );
}
