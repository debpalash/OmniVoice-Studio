import React, { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, Film, Globe, X, Plus, Loader } from 'lucide-react';
import { Button } from '../ui';
import MultiLangPicker from './MultiLangPicker';
import { PRESETS } from '../utils/constants';
import './BatchAddDialog.css';

/**
 * BatchAddDialog — multi-file drop zone + shared settings for batch dubbing.
 *
 * Users drop N video files, pick languages + voice, then click "Add to Queue".
 * Each file is POSTed as a separate job to the batch endpoint.
 */
export default function BatchAddDialog({
  open,
  onClose,
  profiles = [],
  onEnqueue, // async (files, settings) => void
}) {
  const { t } = useTranslation();
  const [files, setFiles] = useState([]);
  const [langs, setLangs] = useState([{ lang: 'Spanish', code: 'es' }]);
  const [voiceId, setVoiceId] = useState('');
  const [preserveBg, setPreserveBg] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('video/'));
    if (dropped.length) setFiles((prev) => [...prev, ...dropped]);
  }, []);

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (!files.length || !langs.length) return;
    setSubmitting(true);
    try {
      await onEnqueue?.(files, { langs, voiceId, preserveBg });
      setFiles([]);
      onClose?.();
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="batch-add-overlay" onClick={onClose}>
      <div className="batch-add" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-[14px_18px] [border-bottom:1px_solid_var(--chrome-border)]">
          <span className="flex items-center gap-[6px] font-mono text-[0.78rem] font-semibold uppercase tracking-[0.04em] text-[var(--chrome-fg)]">
            <Plus size={13} /> {t('batch.add_to_queue_title')}
          </span>
          <button
            type="button"
            className="cursor-pointer rounded-[6px] border-0 bg-transparent p-[4px] text-[var(--chrome-fg-muted)] transition-[background] duration-[0.15s] hover:bg-[var(--chrome-hover-bg)]"
            onClick={onClose}
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-[14px] overflow-y-auto p-[16px_18px]">
          {/* Drop zone */}
          <div
            className="batch-add__drop"
            onDragOver={(e) => {
              e.preventDefault();
              e.currentTarget.classList.add('is-over');
            }}
            onDragLeave={(e) => e.currentTarget.classList.remove('is-over')}
            onDrop={(e) => {
              e.currentTarget.classList.remove('is-over');
              handleDrop(e);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={24} />
            <span>{t('batch.drop_hint_text')}</span>
            <span className="font-mono text-[0.65rem] text-[var(--chrome-fg-dim)]">
              {t('batch.drop_formats')}
            </span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const added = Array.from(e.target.files);
              if (added.length) setFiles((prev) => [...prev, ...added]);
              e.target.value = '';
            }}
          />

          {/* File list */}
          {files.length > 0 && (
            <div className="flex flex-col gap-[4px]">
              <span className="mb-[4px] flex items-center gap-[4px] font-mono text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[var(--chrome-fg-dim)]">
                {t('batch.files_kicker', { count: files.length })}
              </span>
              {files.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-[6px] rounded-[6px] bg-[var(--chrome-hover-bg)] p-[4px_8px] text-[0.76rem]"
                >
                  <Film size={10} />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--chrome-fg)]">
                    {f.name}
                  </span>
                  <span className="shrink-0 font-mono text-[0.68rem] text-[var(--chrome-fg-dim)]">
                    {t('batch.file_size_mb', { size: (f.size / 1024 / 1024).toFixed(1) })}
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded-[4px] border-0 bg-transparent p-[2px] text-[var(--chrome-fg-dim)] hover:text-[var(--color-danger)]"
                    onClick={() => removeFile(i)}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Settings */}
          <div className="flex flex-col gap-[12px]">
            <div className="flex flex-col gap-[6px]">
              <span className="mb-[4px] flex items-center gap-[4px] font-mono text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[var(--chrome-fg-dim)]">
                <Globe size={9} /> {t('batch.target_languages')}
              </span>
              <MultiLangPicker selected={langs} onChange={setLangs} />
            </div>

            <div className="flex flex-col gap-[6px]">
              <span className="mb-[4px] flex items-center gap-[4px] font-mono text-[0.62rem] font-semibold uppercase tracking-[0.04em] text-[var(--chrome-fg-dim)]">
                {t('batch.voice_kicker')}
              </span>
              <select
                className="input-base batch-add__select"
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                <option value="">{t('batch.default_option')}</option>
                {profiles.filter((p) => !p.instruct).length > 0 && (
                  <optgroup label={t('batch.clone_profiles')}>
                    {profiles
                      .filter((p) => !p.instruct)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                {PRESETS.length > 0 && (
                  <optgroup label={t('batch.presets')}>
                    {PRESETS.map((p) => (
                      <option key={p.id} value={`preset:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <label className="batch-add__toggle">
              <input
                type="checkbox"
                checked={preserveBg}
                onChange={(e) => setPreserveBg(e.target.checked)}
              />
              <span>{t('batch.preserve_bg')}</span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-[8px] p-[12px_18px] [border-top:1px_solid_var(--chrome-border)]">
          <span className="flex-1 font-mono text-[0.68rem] text-[var(--chrome-fg-dim)]">
            {files.length > 0 && langs.length > 0
              ? t('batch.estimate', {
                  videos: files.length,
                  langs: langs.length,
                  jobs: files.length * langs.length,
                })
              : t('batch.select_files_langs')}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!files.length || !langs.length || submitting}
            loading={submitting}
            leading={!submitting && <Plus size={10} />}
          >
            {t('batch.add_to_queue')}
          </Button>
        </div>
      </div>
    </div>
  );
}
