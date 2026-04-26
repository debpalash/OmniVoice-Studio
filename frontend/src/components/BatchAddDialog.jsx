import React, { useState, useRef, useCallback } from 'react';
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
  onEnqueue,  // async (files, settings) => void
}) {
  const [files, setFiles] = useState([]);
  const [langs, setLangs] = useState([{ lang: 'Spanish', code: 'es' }]);
  const [voiceId, setVoiceId] = useState('');
  const [preserveBg, setPreserveBg] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
    if (dropped.length) setFiles(prev => [...prev, ...dropped]);
  }, []);

  const removeFile = (idx) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
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
      <div className="batch-add" onClick={e => e.stopPropagation()}>
        <div className="batch-add__head">
          <span className="batch-add__title">
            <Plus size={13} /> Add Videos to Queue
          </span>
          <button type="button" className="batch-add__close" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div className="batch-add__body">
          {/* Drop zone */}
          <div
            className="batch-add__drop"
            onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }}
            onDragLeave={e => e.currentTarget.classList.remove('is-over')}
            onDrop={e => { e.currentTarget.classList.remove('is-over'); handleDrop(e); }}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={24} />
            <span>Drop video files here or click to browse</span>
            <span className="batch-add__drop-hint">MP4 · MOV · MKV · WEBM</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            className="batch-add__file-input"
            onChange={e => {
              const added = Array.from(e.target.files);
              if (added.length) setFiles(prev => [...prev, ...added]);
              e.target.value = '';
            }}
          />

          {/* File list */}
          {files.length > 0 && (
            <div className="batch-add__files">
              <span className="batch-add__kicker">FILES ({files.length})</span>
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="batch-add__file-row">
                  <Film size={10} />
                  <span className="batch-add__file-name">{f.name}</span>
                  <span className="batch-add__file-size">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button type="button" className="batch-add__file-x" onClick={() => removeFile(i)}>
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Settings */}
          <div className="batch-add__settings">
            <div className="batch-add__field">
              <span className="batch-add__kicker"><Globe size={9} /> TARGET LANGUAGES</span>
              <MultiLangPicker selected={langs} onChange={setLangs} />
            </div>

            <div className="batch-add__field">
              <span className="batch-add__kicker">VOICE</span>
              <select
                className="input-base batch-add__select"
                value={voiceId}
                onChange={e => setVoiceId(e.target.value)}
              >
                <option value="">Default</option>
                {profiles.filter(p => !p.instruct).length > 0 && (
                  <optgroup label="Clone Profiles">
                    {profiles.filter(p => !p.instruct).map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </optgroup>
                )}
                {PRESETS.length > 0 && (
                  <optgroup label="Presets">
                    {PRESETS.map(p => (
                      <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

            <label className="batch-add__toggle">
              <input type="checkbox" checked={preserveBg} onChange={e => setPreserveBg(e.target.checked)} />
              <span>Preserve background audio (music/FX)</span>
            </label>
          </div>
        </div>

        <div className="batch-add__foot">
          <span className="batch-add__estimate">
            {files.length > 0 && langs.length > 0
              ? `${files.length} video${files.length > 1 ? 's' : ''} × ${langs.length} lang${langs.length > 1 ? 's' : ''} = ${files.length * langs.length} job${files.length * langs.length > 1 ? 's' : ''}`
              : 'Select files and languages'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!files.length || !langs.length || submitting}
            loading={submitting}
            leading={!submitting && <Plus size={10} />}
          >
            Add to Queue
          </Button>
        </div>
      </div>
    </div>
  );
}
