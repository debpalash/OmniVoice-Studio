// Playback-reference tap for the opt-in AEC path (parity Action 8). Routes an
// <audio>/<video> element's decoded output through a Web Audio graph so the
// dictation AEC can use it as the far-end echo reference — WITHOUT changing
// what the user hears. Only ever called when AEC is enabled; the default
// playback path never constructs an AudioContext.
//
// Constraint: createMediaElementSource() may be called at most once per
// element, and once called the element's audio routes ONLY through the graph.
// So we (a) memoise the source per element, (b) always reconnect it to
// destination to keep it audible, and (c) on detach disconnect only the tap
// node — never the element→destination edge — so toggling AEC or remounting
// the player never silences playback.

import { publishFarEnd } from './farEndBus';

const WORKLET_URL = '/aec-worklet.js';

// element → { ctx, src } so we never double-tap or double-source an element.
const tapped = new WeakMap();

/**
 * Attach (or re-attach) a far-end tap to ``mediaEl``. Returns an async
 * detach() that stops publishing but keeps the element audible.
 */
export async function attachPlaybackTap(mediaEl, { sampleRate = 16000, frameSize = 320 } = {}) {
  if (!mediaEl) return async () => {};

  let entry = tapped.get(mediaEl);
  if (!entry) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate });
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const src = ctx.createMediaElementSource(mediaEl);
    src.connect(ctx.destination); // keep playback audible — set up once, forever
    entry = { ctx, src };
    tapped.set(mediaEl, entry);
  }

  const { ctx, src } = entry;
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* gesture may be required; harmless */ }
  }
  const node = new AudioWorkletNode(ctx, 'aec-frame-emitter', {
    processorOptions: { frameSize },
  });
  node.port.onmessage = (e) => publishFarEnd(e.data);
  src.connect(node);

  return async function detach() {
    try { node.port.onmessage = null; } catch { /* ignore */ }
    try { node.disconnect(); } catch { /* ignore */ }
    // Intentionally leave ctx + src→destination intact (see header note).
  };
}
