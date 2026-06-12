/**
 * useRecording — microphone recording with auto-cleanup via the backend.
 *
 * Extracted from App.jsx to reduce its useState/useRef count.
 */
import { useState, useRef } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { cleanAudio as apiCleanAudio } from '../api/system';
import { micErrorMessage } from '../utils/micError';

export default function useRecording(ingestRefAudio) {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isCleaning, setIsCleaning] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingTimerRef = useRef(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mediaRecorder;
      recordingChunksRef.current = [];
      setRecordingTime(0);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        clearInterval(recordingTimerRef.current);
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(recordingChunksRef.current, { type: 'audio/webm' });
        if (blob.size < 1000) {
          toast.error(t('recording.too_short', { defaultValue: 'Recording too short' }));
          return;
        }

        // Send to backend for denoising
        setIsCleaning(true);
        try {
          const formData = new FormData();
          formData.append("audio", blob, "recording.webm");
          const res = await apiCleanAudio(formData);

          const cleanBlob = await res.blob();
          const cleanFilename = res.headers.get("X-Clean-Filename") || "recording_clean.wav";
          const cleanFile = new File([cleanBlob], cleanFilename, { type: "audio/wav" });

          await ingestRefAudio(cleanFile);
          toast.success(t('recording.cleaned_loaded', { defaultValue: 'Recording cleaned & loaded!' }));
        } catch (e) {
          // Fallback: use raw recording without denoising
          const rawFile = new File([blob], "recording.webm", { type: "audio/webm" });
          await ingestRefAudio(rawFile);
          toast.success(t('recording.loaded_raw', { defaultValue: 'Recording loaded (raw — denoising unavailable)' }));
        } finally {
          setIsCleaning(false);
        }
      };

      mediaRecorder.start(250); // Collect chunks every 250ms
      setIsRecording(true);

      // Timer
      const st = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(((Date.now() - st) / 1000).toFixed(1));
      }, 100);

    } catch (e) {
      // Same actionable mapping as the dictation pill: denied → per-OS
      // settings hint; otherwise no-device / device-busy / generic (#323).
      toast.error(micErrorMessage(t, e), { duration: 6000 });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  return {
    isRecording,
    isCleaning,
    recordingTime,
    startRecording,
    stopRecording,
  };
}
