import React, { useEffect, useRef } from 'react';
import { Scale, Fingerprint, Play, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { PRESETS } from '../utils/constants';
import { generateSpeech } from '../api/generate';
import { Button, Panel, Field, Textarea, Select } from '../ui';
import WaveformPlayer from './WaveformPlayer';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();

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
      setCompareProgress(t('compare.preparing_voice'));
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
      setCompareProgress(t('compare.generating_voice_a'));
      const audioA = await generateVoice(compareVoiceA);
      setCompareResultA(audioA);
      setCompareProgress(t('compare.generating_voice_b'));
      const audioB = await generateVoice(compareVoiceB);
      setCompareResultB(audioB);
      setCompareProgress('');
      toast.success(t('compare.comparison_complete'));
      loadHistory();
    } catch (err) {
      toast.error(t('compare.play_failed', { message: err.message }));
      setCompareProgress('');
    } finally {
      setIsComparing(false);
    }
  };

  const canCompare = !isComparing && compareVoiceA && compareVoiceB && compareText.trim();

  if (!open) return null;

  return (
    <div className="compare-drawer" role="dialog" aria-modal="false" aria-label={t('compare.title')}>
      <div className="compare-drawer__sheet" ref={drawerRef}>
        <header className="compare-drawer__head">
          <span className="compare-drawer__handle" aria-hidden="true" />
          <span className="compare-drawer__title">
            <Scale size={14} /> {t('compare.title')}
          </span>
          <button
            type="button"
            className="compare-drawer__close"
            onClick={onClose}
            aria-label={t('compare.close')}
          >
            <X size={12} />
          </button>
        </header>

        <div className="compare-drawer__body">
          <p className="ui-compare__desc">
            {t('compare.desc')}
          </p>

          <Field label={t('compare.test_phrase')}>
            <Textarea
              value={compareText}
              onChange={e => setCompareText(e.target.value)}
              rows={2}
              className="compare-textarea--noresize"
            />
          </Field>

          <div className="ui-compare__grid">
            <CompareSide
              accent="var(--color-brand)"
              label={t('compare.voice_a')}
              profiles={profiles}
              value={compareVoiceA}
              onChange={setCompareVoiceA}
              audio={compareResultA}
            />
            <CompareSide
              accent="var(--color-success)"
              label={t('compare.voice_b')}
              profiles={profiles}
              value={compareVoiceB}
              onChange={setCompareVoiceB}
              audio={compareResultB}
            />
          </div>
        </div>

        <footer className="compare-drawer__foot">
          <Button variant="ghost" onClick={onClose}>{t('compare.close_btn')}</Button>
          <Button
            variant="primary"
            loading={isComparing}
            disabled={!canCompare}
            onClick={runCompare}
            leading={!isComparing && <Play size={12} />}
          >
            {isComparing ? (compareProgress || t('compare.comparing')) : t('compare.compare_btn')}
          </Button>
        </footer>
      </div>
    </div>
  );
}

function CompareSide({ accent, label, profiles, value, onChange, audio }) {
  const { t } = useTranslation();
  return (
    <Panel variant="flat" padding="sm">
      <h3 className="ui-compare__head" style={{ color: accent }}>
        <Fingerprint size={14} /> {label}
      </h3>
      <Field>
        <Select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">{t('compare.select_voice')}</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          {PRESETS.map(p => <option key={p.id} value={`preset:${p.id}`}>{p.name} {t('compare.preset_suffix')}</option>)}
        </Select>
      </Field>
      {audio ? (
        <WaveformPlayer src={audio} source="compare" className="ui-compare__audio" />
      ) : (
        <div className="ui-compare__audio-empty">{t('compare.no_audio')}</div>
      )}
    </Panel>
  );
}
