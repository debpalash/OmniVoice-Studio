/**
 * Media utilities shared across the app.
 *
 * Extracted from App.jsx to reduce file size and enable independent testing.
 */
import { API_BASE as _PREVIEW_API, isTauriContext } from './apiBase';
import { claimPlayback } from './playback';
import { apiFetch } from '../api/client';

const isTauri = isTauriContext();

// ── Tauri window maximise on double-click ─────────────────────────────
let tauriWindow = null;
if (isTauri) {
  import('@tauri-apps/api/window').then(m => { tauriWindow = m; });
}
export const doubleClickMaximize = () => {
  if (tauriWindow) tauriWindow.getCurrentWindow().toggleMaximize();
};

// ── File → media URL ──────────────────────────────────────────────────
// _PREVIEW_API is now sourced from utils/apiBase.ts so Docker LAN users
// (issue #80) get window.location.hostname:3900 instead of localhost:3900.

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
      const res = await apiFetch(`${_PREVIEW_API}/preview/upload`, { method: 'POST', body: form });
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
 *
 * Registered with the global playback manager (issue #316): starting any
 * other preview stops this one, and `stopActivePlayback()` halts it — the
 * old fire-and-forget version could neither be stopped nor de-overlapped.
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
      const release = claimPlayback(() => {
        try { src.stop(); } catch { /* already stopped */ }
        ctx.close();
      }, 'output');
      src.start(0);
      src.onended = () => { ctx.close(); release(); };
    } catch (e) {
      // Expected & recovered on WebView2 (Windows): decodeAudioData decodes the
      // WHOLE file into one PCM AudioBuffer and chokes on long-form audiobook/
      // story renders (.m4b / AAC) — a `warn`, not a red ERROR, since the
      // streaming fallback below recovers it. (The scary "decode error" line
      // users saw in Logs → Frontend was this expected branch, logged at error
      // level even when playback succeeded.)
      console.warn('playBlobAudio: Web Audio decode failed, falling back to streamed playback:', e?.message || e);
      ctx.close();
      // Fallback (#653): a blob: URL won't play in an <audio> element under
      // Tauri's WebKit (see fileToMediaUrl above), so upload to the backend
      // preview endpoint (ffmpeg-extracts a streamable WAV) and play the HTTP
      // URL — the same path video previews already use. Streams; no whole-file
      // decode. NOTE: _PREVIEW_API must be 127.0.0.1 (not localhost) or this
      // fetch misses the IPv4 backend on Windows (see utils/apiBase.ts).
      try {
        const form = new FormData();
        form.append('video', blob, 'preview.audio');
        const res = await apiFetch(`${_PREVIEW_API}/preview/upload`, { method: 'POST', body: form });
        const data = await res.json();
        const url = `${_PREVIEW_API}${data.audioUrl || data.url}`;
        const a = new Audio(url);
        const release = claimPlayback(() => { a.pause(); }, 'output');
        a.onended = () => { release(); };
        await a.play().catch((err) => { release(); throw err; });
      } catch (e2) {
        // Real failure — both decode AND the streamed fallback failed.
        console.error('playBlobAudio: streamed fallback also failed:', e2?.message || e2);
      }
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    const release = claimPlayback(() => {
      a.pause();
      URL.revokeObjectURL(url);
    }, 'output');
    a.onended = () => { URL.revokeObjectURL(url); release(); };
    a.play().catch((e) => {
      release();
      console.error('playBlobAudio play error:', e);
    });
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
