import { describe, it, expect, vi, beforeEach } from 'vitest';

// A single callable spy that also carries `.success` / `.error`, matching the
// react-hot-toast shape (default + named `toast` are the same object).
const { toastFn } = vi.hoisted(() => {
  const fn = vi.fn();
  fn.success = vi.fn();
  fn.error = vi.fn();
  return { toastFn: fn };
});
vi.mock('react-hot-toast', () => ({ default: toastFn, toast: toastFn }));

import { notifyEngineSelected } from '../utils/engineSelectToast';

// Fake `t` that echoes key + interpolation vars so assertions can see both.
const t = (key, vars) => `${key}:${JSON.stringify(vars || {})}`;

describe('notifyEngineSelected (routing echo → toast)', () => {
  beforeEach(() => {
    toastFn.mockClear();
    toastFn.success.mockClear();
  });

  it('warns (with the reason) when the pick lands on a cpu_fallback', () => {
    notifyEngineSelected(
      {
        active: 'indextts2',
        routing_status: 'cpu_fallback',
        routing_reason: 'engine has no CUDA path; running on CPU',
      },
      t,
      'tts',
    );
    // Warn path uses the bare toast() with an icon; NOT toast.success.
    expect(toastFn.success).not.toHaveBeenCalled();
    expect(toastFn).toHaveBeenCalledTimes(1);
    const [msg, opts] = toastFn.mock.calls[0];
    expect(msg).toContain('engines.selectCpuFallback');
    expect(msg).toContain('indextts2');
    expect(msg).toContain('engine has no CUDA path; running on CPU');
    expect(opts).toMatchObject({ icon: expect.any(String) });
  });

  it('shows a plain success toast for an accelerated pick', () => {
    notifyEngineSelected(
      { active: 'omnivoice', routing_status: 'accelerated', routing_reason: null },
      t,
      'tts',
    );
    expect(toastFn).not.toHaveBeenCalled(); // no warn toast
    expect(toastFn.success).toHaveBeenCalledTimes(1);
    expect(toastFn.success.mock.calls[0][0]).toContain('settings.engine_switched');
    expect(toastFn.success.mock.calls[0][0]).toContain('TTS');
  });

  it('shows a plain success toast for a benign cpu_only pick', () => {
    notifyEngineSelected(
      { active: 'kittentts', routing_status: 'cpu_only', routing_reason: null },
      t,
      'tts',
    );
    expect(toastFn).not.toHaveBeenCalled();
    expect(toastFn.success).toHaveBeenCalledTimes(1);
  });

  it('shows a plain success toast for a legacy response with no routing_status', () => {
    notifyEngineSelected({ active: 'legacy' }, t, 'asr');
    expect(toastFn).not.toHaveBeenCalled();
    expect(toastFn.success).toHaveBeenCalledTimes(1);
    expect(toastFn.success.mock.calls[0][0]).toContain('ASR');
  });
});
