import React, { useEffect, useRef } from 'react';
import { Scale, Fingerprint, Play, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { PRESETS } from '../utils/constants';
import { generateSpeech } from '../api/generate';
import { Button, Panel, Field, Textarea, Select } from '../ui';
import './CompareModal.css';

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
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    const onPointer = (e) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target)) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    // Defer click-outside so the opening click doesn't immediately close.
    const t = setTimeout(() => window.addEventListener('mousedown', onPointer), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
      clearTimeout(t);
    };
  }, [open, onClose]);

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

  const canCompare = !isComparing && compareVoiceA && compareVoiceB && compareText.trim();

  if (!open) return null;

  return (
    <div className="compare-drawer" role="dialog" aria-modal="false" aria-label="A/B Voice Comparison">
      <div className="compare-drawer__sheet" ref={drawerRef}>
        <header className="compare-drawer__head">
          <span className="compare-drawer__handle" aria-hidden="true" />
          <span className="compare-drawer__title">
            <Scale size={14} /> A/B Voice Comparison
          </span>
          <button
            type="button"
            className="compare-drawer__close"
            onClick={onClose}
            aria-label="Close comparison"
          >
            <X size={12} />
          </button>
        </header>

        <div className="compare-drawer__body">
          <p className="ui-compare__desc">
            Compare two voices side by side to make casting decisions. App stays interactive behind.
          </p>

          <Field label="Test phrase">
            <Textarea
              value={compareText}
              onChange={e => setCompareText(e.target.value)}
              rows={2}
              style={{ resize: 'none' }}
            />
          </Field>

          <div className="ui-compare__grid">
            <CompareSide
              accent="var(--color-brand)"
              label="Voice A"
              profiles={profiles}
              value={compareVoiceA}
              onChange={setCompareVoiceA}
              audio={compareResultA}
            />
            <CompareSide
              accent="var(--color-success)"
              label="Voice B"
              profiles={profiles}
              value={compareVoiceB}
              onChange={setCompareVoiceB}
              audio={compareResultB}
            />
          </div>
        </div>

        <footer className="compare-drawer__foot">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={isComparing}
            disabled={!canCompare}
            onClick={runCompare}
            leading={!isComparing && <Play size={12} />}
          >
            {isComparing ? (compareProgress || 'Comparing…') : 'Compare'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function CompareSide({ accent, label, profiles, value, onChange, audio }) {
  return (
    <Panel variant="flat" padding="sm">
      <h3 className="ui-compare__head" style={{ color: accent }}>
        <Fingerprint size={14} /> {label}
      </h3>
      <Field>
        <Select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">— Select voice —</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} (Preset)</option>)}
        </Select>
      </Field>
      {audio ? (
        <audio src={audio} controls className="ui-compare__audio" />
      ) : (
        <div className="ui-compare__audio-empty">No audio yet</div>
      )}
    </Panel>
  );
}
