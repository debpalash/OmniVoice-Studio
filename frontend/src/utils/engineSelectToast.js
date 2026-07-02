/**
 * notifyEngineSelected — post-select feedback for a TTS/ASR/LLM engine pick.
 *
 * `/engines/select` echoes the routing verdict (routing_status /
 * effective_device / routing_reason) for the picked engine on THIS host
 * precisely so the UI can warn when the pick lands on a CPU fallback — it
 * still runs, just slower. Before this, every pick fired the same plain
 * "switched" success toast, hiding the fact that a GPU engine was silently
 * downgraded to CPU on this machine (backend note: engines.py select echo).
 *
 *   - routing_status === 'cpu_fallback' → warn-tone toast naming the reason.
 *   - everything else (accelerated / cpu_only / n/a / legacy) → plain success.
 *
 * Shared by Settings → Engines and the first-run WizardLibrary so both paths
 * consume the echo identically.
 */
import { toast } from 'react-hot-toast';

export function notifyEngineSelected(r, t, family = 'tts') {
  if (r?.routing_status === 'cpu_fallback') {
    toast(
      t('engines.selectCpuFallback', {
        engine: r.active,
        reason: r.routing_reason || '',
      }),
      { icon: '⚠️' },
    );
    return;
  }
  toast.success(
    t('settings.engine_switched', {
      family: (family || '').toUpperCase(),
      engine: r?.active,
    }),
  );
}
