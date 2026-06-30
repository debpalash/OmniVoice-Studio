import {
  Globe,
  SlidersHorizontal,
  Settings2,
  ChevronUp,
  ChevronDown,
  Play,
  Square,
} from 'lucide-react';
import { Button, Progress } from '../../ui';
import SearchableSelect from '../SearchableSelect';
import ALL_LANGUAGES from '../../languages.json';
import { POPULAR_LANGS } from '../../utils/constants';
import { stopActivePlayback } from '../../utils/playback';

export default function ActionBar({
  t,
  showOverrides,
  setShowOverrides,
  cfg,
  setCfg,
  speed,
  setSpeed,
  tShift,
  setTShift,
  posTemp,
  setPosTemp,
  classTemp,
  setClassTemp,
  layerPenalty,
  setLayerPenalty,
  duration,
  setDuration,
  denoise,
  setDenoise,
  postprocess,
  setPostprocess,
  language,
  setLanguage,
  steps,
  setSteps,
  showHearDemo,
  playDemoOutput,
  demoAudioPlaying,
  demoAudioRef,
  demoReleaseRef,
  setDemoAudioPlaying,
  outputPlaying,
  isGenerating,
  handleGenerate,
  generationTime,
  wasGeneratingRef,
}) {
  return (
    <div className="studio-action-bar clone-panel--overflow-visible">
      {showOverrides && (
        <div className="override-content">
          <div className="grid-4">
            <div>
              <div className="label-row label-row--spread">
                <span>CFG</span>
                <span className="val-bubble">{cfg}</span>
              </div>
              <input
                type="range"
                min="1.0"
                max="4.0"
                step="0.1"
                value={cfg}
                onChange={(e) => setCfg(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span>{t('clone.speed')}</span>
                <span className="val-bubble">{speed}x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span>{t('clone.tshift')}</span>
                <span className="val-bubble">{tShift}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.0"
                step="0.05"
                value={tShift}
                onChange={(e) => setTShift(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span>{t('clone.pos_temp')}</span>
                <span className="val-bubble">{posTemp}</span>
              </div>
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={posTemp}
                onChange={(e) => setPosTemp(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span>{t('clone.class_temp')}</span>
                <span className="val-bubble">{classTemp}</span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={classTemp}
                onChange={(e) => setClassTemp(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row label-row--spread">
                <span>{t('clone.layer_pen')}</span>
                <span className="val-bubble">{layerPenalty}</span>
              </div>
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={layerPenalty}
                onChange={(e) => setLayerPenalty(Number(e.target.value))}
              />
            </div>
            <div>
              <div className="label-row">
                <span>{t('clone.duration')}</span>
              </div>
              <input
                type="text"
                className="input-base clone-duration-input"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder={t('clone.auto')}
              />
            </div>
            <div className="clone-prod-col">
              <label className="clone-prod-check">
                <input
                  type="checkbox"
                  checked={denoise}
                  onChange={(e) => setDenoise(e.target.checked)}
                />{' '}
                {t('clone.denoise')}
              </label>
              <label className="clone-prod-check">
                <input
                  type="checkbox"
                  checked={postprocess}
                  onChange={(e) => setPostprocess(e.target.checked)}
                />{' '}
                {t('clone.postprocess')}
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Controls row: language · steps · overrides disclosure */}
      <div className="studio-action-bar__row">
        <div className="studio-action-bar__lang">
          <Globe size={12} className="label-icon" />
          <SearchableSelect
            value={language}
            options={ALL_LANGUAGES}
            popular={POPULAR_LANGS}
            recentsKey="omnivoice.recents.genLang"
            onChange={setLanguage}
          />
        </div>
        <label className="studio-action-bar__steps" title={t('clone.steps')}>
          <SlidersHorizontal size={12} className="label-icon" />
          <input
            type="range"
            min="8"
            max="64"
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
          />
          <span className="val-bubble">{steps}</span>
        </label>
        <button
          type="button"
          className="studio-action-bar__overrides"
          onClick={() => setShowOverrides(!showOverrides)}
          aria-expanded={showOverrides}
        >
          <Settings2 size={13} /> {t('clone.production_overrides')}
          {showOverrides ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>

      {showHearDemo ? (
        <>
          <Button
            variant="primary"
            block
            onClick={playDemoOutput}
            leading={<Play size={14} />}
            className="clone-footer-cta"
          >
            {demoAudioPlaying ? t('demo.stop_demo') : t('demo.hear_demo')}
          </Button>
          <div className="clone-hear-demo-chip">{t('demo.prerendered_chip')}</div>
          <audio
            ref={demoAudioRef}
            onEnded={() => {
              setDemoAudioPlaying(false);
              demoReleaseRef.current?.();
              demoReleaseRef.current = null;
            }}
            preload="none"
          />
        </>
      ) : outputPlaying && !isGenerating ? (
        /* Synthesized output is playing — the CTA becomes a Stop button
             (#316) so playback can be halted immediately. */
        <Button
          variant="primary"
          block
          onClick={stopActivePlayback}
          leading={<Square size={14} />}
          className="clone-footer-cta"
        >
          {t('clone.stop_playback')}
        </Button>
      ) : (
        <Button
          variant="primary"
          block
          loading={isGenerating}
          onClick={handleGenerate}
          leading={!isGenerating && <Play size={14} />}
          className="clone-footer-cta"
        >
          {isGenerating
            ? t('clone.synthesizing', { seconds: generationTime })
            : t('clone.synthesize')}
        </Button>
      )}
      {isGenerating && (
        <Progress
          value={Math.min((generationTime / 8) * 100, 95)}
          tone="brand"
          size="sm"
          className="clone-footer-cta"
        />
      )}
      {/* 10x P4 a11y (spec §3): persistent polite live region — screen
            readers hear generation start AND finish in-workspace, without
            relying on the FloatingPill. sr-only keeps it out of the
            action-bar flex flow; static text avoids per-second re-announces
            from the ticking "Synthesizing… (Ns)" button label. */}
      <div className="sr-only" role="status" aria-live="polite">
        {isGenerating
          ? t('clone.generating_status', { defaultValue: 'Generating audio…' })
          : wasGeneratingRef.current
            ? t('clone.generating_done_status', { defaultValue: 'Generation finished' })
            : null}
      </div>
    </div>
  );
}
