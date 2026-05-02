/**
 * Media utilities shared across the app.
 *
 * Extracted from App.jsx to reduce file size and enable independent testing.
 */

const isTauri = typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

// ── Tauri window maximise on double-click ─────────────────────────────
let tauriWindow = null;
if (isTauri) {
  import('@tauri-apps/api/window').then(m => { tauriWindow = m; });
}
export const doubleClickMaximize = () => {
  if (tauriWindow) tauriWindow.getCurrentWindow().toggleMaximize();
};

// ── File → media URL ──────────────────────────────────────────────────

const _PREVIEW_API = import.meta.env.VITE_OMNIVOICE_API || 'http://localhost:3900';

/**
 * Convert a File object to a media-safe URL.
 * In Tauri's WebKit, blob: URLs fail for <video>/<audio> elements.
 * We upload to the backend's /preview endpoint and serve via HTTP instead.
 * Falls back to createObjectURL for regular browsers.
 */
export const fileToMediaUrl = async (file, prevUrls) => {
  // Revoke previous blob URLs if they exist
  if (prevUrls?.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(prevUrls.videoUrl);
  if (prevUrls?.audioUrl?.startsWith('blob:')) URL.revokeObjectURL(prevUrls.audioUrl);
  
  if (isTauri) {
    try {
      const form = new FormData();
      form.append('video', file, file.name || 'media.wav');
      const res = await fetch(`${_PREVIEW_API}/preview/upload`, { method: 'POST', body: form });
      const data = await res.json();
      return {
        videoUrl: `${_PREVIEW_API}${data.url}`,
        audioUrl: data.audioUrl ? `${_PREVIEW_API}${data.audioUrl}` : `${_PREVIEW_API}${data.url}`
      };
    } catch (e) {
      console.warn('Preview upload failed, falling back to blob URL:', e);
    }
  }
  const url = URL.createObjectURL(file);
  return { videoUrl: url, audioUrl: url };
};

// ── Blob audio playback ───────────────────────────────────────────────

/**
 * Play audio from a Blob. Uses Web Audio API in Tauri (blob URLs blocked)
 * and standard Audio() elsewhere.
 */
export const playBlobAudio = async (blob) => {
  if (isTauri) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // WebKit suspends AudioContext by default — must resume before decoding
    if (ctx.state === 'suspended') await ctx.resume();
    try {
      const buf = await blob.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      src.start(0);
      src.onended = () => ctx.close();
    } catch (e) {
      console.error('playBlobAudio decode error:', e);
      ctx.close();
      // Fallback: try the standard Audio() path even in Tauri
      try {
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        await a.play();
        a.onended = () => URL.revokeObjectURL(url);
      } catch (e2) {
        console.error('playBlobAudio fallback error:', e2);
      }
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a.play().catch((e) => console.error('playBlobAudio play error:', e));
    a.onended = () => URL.revokeObjectURL(url);
  }
};

// ── Notification ping ─────────────────────────────────────────────────

let _pingCtx = null;
export const playPing = () => {
  try {
    if (!_pingCtx) _pingCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _pingCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.03);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) {}
};

// Re-export for convenience
export { isTauri };
