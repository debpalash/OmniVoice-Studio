import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { createProfile, deleteProfile as apiDeleteProfile, lockProfile, unlockProfile } from '../api/profiles';
import { generateSpeech, audioUrlWithCacheBust } from '../api/generate';
import { apiFetch } from '../api/client';
import { playBlobAudio } from '../utils/media';
import { PRESETS } from '../utils/constants';
import { instructToFormValue } from '../utils/voiceInstruct';
import { askConfirm } from '../utils/dialog';
import { toast } from 'react-hot-toast';
import { evaluateDonationPrompt } from '../components/donate/evaluateDonationPrompt';

/**
 * Encapsulates voice-profile CRUD, lock/unlock, preview, and save-from-history.
 */
export default function useProfiles({ loadHistory, loadProfiles }) {
  const { t } = useTranslation();
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [previewLoading, setPreviewLoading] = useState(null);
  const [segmentPreviewLoading, setSegmentPreviewLoading] = useState(null);

  // Voice Preview floating card
  const [isVoicePreviewOpen, setIsVoicePreviewOpen] = useState(false);
  const [voicePreviewProfileId, setVoicePreviewProfileId] = useState('');

  const setRefText = useAppStore(s => s.setRefText);
  const setInstruct = useAppStore(s => s.setInstruct);
  const setLanguage = useAppStore(s => s.setLanguage);
  const setVdStates = useAppStore(s => s.setVdStates);
  const setDefineMethod = useAppStore(s => s.setDefineMethod);
  const language = useAppStore(s => s.language);
  const mode = useAppStore(s => s.mode);
  const steps = useAppStore(s => s.steps);
  const cfg = useAppStore(s => s.cfg);
  const dubLang = useAppStore(s => s.dubLang);
  const dubSegments = useAppStore(s => s.dubSegments);
  const text = useAppStore(s => s.text);

  // loadProfiles is provided by useAppData (single source of truth)

  const handleSaveProfile = useCallback(async (refAudio, refText, instruct, language) => {
    if (!profileName.trim() || !refAudio) return toast.error(t('profiles.need_name_audio'));
    const formData = new FormData();
    formData.append("name", profileName);
    const arrBuf = await refAudio.arrayBuffer();
    const safeBlob = new Blob([arrBuf], { type: refAudio.type });
    formData.append("ref_audio", safeBlob, refAudio.name || "profile.wav");
    formData.append("ref_text", refText);
    formData.append("instruct", instruct);
    formData.append("language", language);
    try {
      await createProfile(formData);
      setShowSaveProfile(false);
      setProfileName('');
      await loadProfiles();
      // Success-only donation prompt (#007). A saved voice clone is a real
      // deliverable — and the *first* one triggers the 'first-clone' milestone.
      evaluateDonationPrompt('clone');
    } catch (e) { toast.error(e.message); }
  }, [profileName, loadProfiles, t]);

  const handleDeleteProfile = useCallback(async (id) => {
    if (!(await askConfirm('Delete this voice profile?'))) return;
    await apiDeleteProfile(id);
    if (selectedProfile === id) setSelectedProfile(null);
    await loadProfiles();
  }, [selectedProfile, loadProfiles]);

  const handleSelectProfile = useCallback((profile) => {
    setSelectedProfile(profile.id);
    setRefText(profile.ref_text || '');
    setInstruct(profile.instruct || '');
    if (profile.language && profile.language !== 'Auto') setLanguage(profile.language);
    // The profile's kind picks the "Define voice" method implicitly: design
    // profiles open the design controls, everything else the audio path.
    setDefineMethod(profile.kind === 'design' ? 'design' : 'audio');
    // Design profiles (0005) carry their category picks — restore the sliders
    // so selecting one makes it re-editable, not just re-usable.
    if (profile.kind === 'design' && profile.vd_states) {
      try {
        const parsed = JSON.parse(profile.vd_states);
        if (parsed && typeof parsed === 'object') setVdStates(parsed);
      } catch { /* malformed stored state — sliders keep their current values */ }
    }
  }, [setRefText, setInstruct, setLanguage, setVdStates, setDefineMethod]);

  /** Save the current design (vd_states + instruct) as a reusable profile.
      The backend renders a deterministic identity sample (seed 42). */
  const handleSaveDesignProfile = useCallback(async (vdStates, instruct, language) => {
    if (!profileName.trim()) return toast.error('Need a profile name');
    const fd = new FormData();
    fd.append('name', profileName);
    fd.append('kind', 'design');
    fd.append('vd_states', JSON.stringify(vdStates || {}));
    // Defensive: instruct must be the STRING. buildDesignInstruct() returns an
    // object — appending it coerced to "[object Object]", poisoning the profile
    // (#550 et al). instructToFormValue extracts .instruct if an object slips
    // through, so the field is never garbage.
    fd.append('instruct', instructToFormValue(instruct));
    fd.append('language', language || 'Auto');
    try {
      await createProfile(fd);
      setShowSaveProfile(false);
      setProfileName('');
      await loadProfiles();
      toast.success('Design saved as a voice profile');
    } catch (e) { toast.error(e.message); }
  }, [profileName, loadProfiles]);

  const handlePreviewVoice = useCallback(async (proj, e) => {
    e.stopPropagation();
    if (previewLoading) return;

    let previewText = "This is a voice preview.";
    let reqLang = language;

    if (mode === 'dub' && dubSegments.length > 0) {
      let seg = dubSegments.find(s => s.profile_id === proj.id && s.text.trim().length > 0);
      if (!seg) seg = dubSegments.find(s => s.text.trim().length > 0);
      if (seg) previewText = seg.text;
      reqLang = dubLang;
    } else if (text.trim() !== '') {
      previewText = text;
    }

    setPreviewLoading(proj.id);
    const toastId = toast.loading(t('profiles.synthesizing_preview', { name: proj.name }));

    try {
      const formData = new FormData();
      formData.append("text", previewText);
      formData.append("profile_id", proj.id);
      if (reqLang && reqLang !== 'Auto') formData.append("language", reqLang);
      formData.append("num_step", steps || 16);
      const res = await generateSpeech(formData);
      const blob = await res.blob();
      toast.success(t('profiles.preview_ready'), { id: toastId });
      playBlobAudio(blob).catch(() => toast.error(t('profiles.playback_failed'), { id: toastId }));
      await loadHistory();
    } catch (err) {
      toast.error(t('profiles.preview_failed', { message: err.message }), { id: toastId });
    } finally {
      setPreviewLoading(null);
    }
  }, [previewLoading, language, mode, dubSegments, dubLang, text, steps, loadHistory, t]);

  const handleSegmentPreview = useCallback(async (seg, e) => {
    e.preventDefault();
    if (segmentPreviewLoading) return;
    setSegmentPreviewLoading(seg.id);
    const toastId = toast.loading(t('profiles.synthesizing_segment'));

    try {
      const formData = new FormData();
      formData.append("text", seg.text);

      let fin_prof = seg.profile_id || '';
      let fin_inst = seg.instruct || '';

      if (fin_prof.startsWith('preset:')) {
        const pr = PRESETS.find(p => p.id === fin_prof.replace('preset:', ''));
        if (pr) {
          const parts = Object.values(pr.attrs).filter(v => v !== 'Auto');
          if (fin_inst.trim()) parts.push(fin_inst.trim());
          fin_inst = parts.join(', ');
        }
        fin_prof = '';
      }

      if (fin_prof) formData.append("profile_id", fin_prof);
      if (fin_inst) formData.append("instruct", fin_inst);
      const fin_lang = seg.target_lang || dubLang;
      if (fin_lang !== 'Auto') formData.append("language", fin_lang);

      formData.append("num_step", 8);
      formData.append("guidance_scale", cfg || 2.0);
      if (seg.speed && seg.speed !== 1.0) formData.append("speed", seg.speed);

      const res = await generateSpeech(formData);
      const blob = await res.blob();
      toast.success(t('profiles.preview_ready'), { id: toastId });
      playBlobAudio(blob).catch(() => toast.error(t('profiles.playback_failed'), { id: toastId }));
    } catch (err) {
      toast.error(t('profiles.preview_failed', { message: err.message }), { id: toastId });
    } finally {
      setSegmentPreviewLoading(null);
    }
  }, [segmentPreviewLoading, dubLang, cfg, t]);

  const handleSaveHistoryAsProfile = useCallback(async (item) => {
    try {
      const pName = `Voice ${new Date().toLocaleTimeString('en', {hour:'2-digit', minute:'2-digit'})} — ${(item.mode||'design').toUpperCase()}`;
      const response = await apiFetch(audioUrlWithCacheBust(item.audio_path));
      const blob = await response.blob();
      const file = new File([blob], item.audio_path, { type: "audio/wav" });

      const formData = new FormData();
      formData.append("name", pName);
      formData.append("ref_audio", file);
      const extractedText = item.text ? (item.text.length > 50 ? item.text.substring(0, 50) : item.text) : "";
      formData.append("ref_text", extractedText);
      formData.append("instruct", item.instruct || "");
      formData.append("language", item.language || "Auto");
      if (item.seed !== undefined && item.seed !== null) {
        formData.append("seed", item.seed);
      }

      await createProfile(formData);
      toast.success(t('profiles.saved'));
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || t('profiles.save_failed'));
    }
  }, [loadProfiles, t]);

  const handleLockProfile = useCallback(async (profileId, historyId, seed) => {
    try {
      const formData = new FormData();
      formData.append("history_id", historyId);
      if (seed !== null && seed !== undefined) formData.append("seed", seed);
      await lockProfile(profileId, formData);
      toast.success(t('profiles.locked'));
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || t('profiles.lock_failed'));
    }
  }, [loadProfiles, t]);

  const handleUnlockProfile = useCallback(async (profileId) => {
    try {
      await unlockProfile(profileId);
      toast.success(t('profiles.unlocked'));
      await loadProfiles();
    } catch (e) {
      toast.error(e.message || t('profiles.unlock_failed'));
    }
  }, [loadProfiles, t]);

  return {
    selectedProfile, setSelectedProfile,
    showSaveProfile, setShowSaveProfile,
    profileName, setProfileName,
    previewLoading, segmentPreviewLoading,
    isVoicePreviewOpen, setIsVoicePreviewOpen,
    voicePreviewProfileId, setVoicePreviewProfileId,
    handleSaveProfile,
    handleSaveDesignProfile,
    handleDeleteProfile,
    handleSelectProfile,
    handlePreviewVoice,
    handleSegmentPreview,
    handleSaveHistoryAsProfile,
    handleLockProfile,
    handleUnlockProfile,
  };
}
