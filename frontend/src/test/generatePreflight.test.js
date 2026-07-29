import { describe, it, expect, vi, beforeEach } from 'vitest';

const { toastFn, listEnginesMock } = vi.hoisted(() => {
  const fn = vi.fn();
  fn.success = vi.fn();
  fn.error = vi.fn();
  return { toastFn: fn, listEnginesMock: vi.fn() };
});
vi.mock('react-hot-toast', () => ({ default: toastFn, toast: toastFn }));
vi.mock('../api/engines', () => ({ listEngines: listEnginesMock }));
vi.mock('i18next', () => ({
  default: { t: (key, vars) => `${key}:${JSON.stringify(vars || {})}` },
}));

import {
  warnIfEngineUnderProvisioned,
  onEngineSelected,
  _resetPreflight,
} from '../utils/generatePreflight';

const VRAM_CAVEAT =
  'NVIDIA GeForce RTX 2060 has 6.0 GB VRAM; this engine wants about 6 GB. ' +
  'It will run, but expect slow generations that may time out.';

function engines(active, backends) {
  return { tts: { active, backends } };
}

describe('warnIfEngineUnderProvisioned (generate-time preflight)', () => {
  beforeEach(() => {
    toastFn.mockClear();
    listEnginesMock.mockReset();
    _resetPreflight();
  });

  // The whole point of #1240/#1246/#1248/#1277/#1283/#1284: the caveat existed
  // the entire time, but only the engine-PICK path showed it. Users whose
  // engine was already selected waited out 300s to learn their card was small.
  it('warns when the already-selected engine carries a VRAM caveat', async () => {
    listEnginesMock.mockResolvedValue(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: VRAM_CAVEAT },
      ]),
    );

    await warnIfEngineUnderProvisioned();

    expect(toastFn).toHaveBeenCalledTimes(1);
    const [msg, opts] = toastFn.mock.calls[0];
    expect(msg).toContain('engines.generateCaveat');
    expect(msg).toContain('omnivoice');
    expect(msg).toContain('6.0 GB VRAM');
    // Long enough to read a sentence about hardware.
    expect(opts.duration).toBeGreaterThanOrEqual(8000);
  });

  it('warns only once per engine+reason, not on every synth', async () => {
    listEnginesMock.mockResolvedValue(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: VRAM_CAVEAT },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    await warnIfEngineUnderProvisioned();
    await warnIfEngineUnderProvisioned();

    expect(toastFn).toHaveBeenCalledTimes(1);
  });

  it('stays silent for a healthy accelerated engine', async () => {
    listEnginesMock.mockResolvedValue(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: null },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    expect(toastFn).not.toHaveBeenCalled();
  });

  // Benign verdicts carry reasons too — routing rule 5 (DirectML) and rule 6.
  it('stays silent for a benign cpu_only reason', async () => {
    listEnginesMock.mockResolvedValue(
      engines('kittentts', [
        {
          id: 'kittentts',
          routing_status: 'cpu_only',
          routing_reason: 'DirectML GPU present; engine routes via torch CPU path',
        },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    expect(toastFn).not.toHaveBeenCalled();
  });

  it('warns on a cpu_fallback engine', async () => {
    listEnginesMock.mockResolvedValue(
      engines('indextts2', [
        {
          id: 'indextts2',
          routing_status: 'cpu_fallback',
          routing_reason: 'engine has no CUDA path; running on CPU',
        },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    expect(toastFn).toHaveBeenCalledTimes(1);
  });

  // A warning must never be able to break the thing it warns about.
  it('never throws when the engine list is unreachable', async () => {
    listEnginesMock.mockRejectedValue(new Error('backend down'));
    await expect(warnIfEngineUnderProvisioned()).resolves.toBeUndefined();
    expect(toastFn).not.toHaveBeenCalled();
  });

  it('tolerates a response with no active engine', async () => {
    listEnginesMock.mockResolvedValue({ tts: { active: null, backends: [] } });
    await expect(warnIfEngineUnderProvisioned()).resolves.toBeUndefined();
    expect(toastFn).not.toHaveBeenCalled();
  });

  it('fetches the engine list once, not once per synth', async () => {
    listEnginesMock.mockResolvedValue(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: null },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    await warnIfEngineUnderProvisioned();

    expect(listEnginesMock).toHaveBeenCalledTimes(1);
  });
});

describe('preflight cache invalidation', () => {
  beforeEach(() => {
    toastFn.mockClear();
    listEnginesMock.mockReset();
    _resetPreflight();
  });

  // Greptile P1: with a 60s TTL, switching engines and generating immediately
  // warned about the engine you just LEFT — or stayed silent about the one you
  // just chose.
  it('refetches after an engine change instead of serving the old engine', async () => {
    listEnginesMock.mockResolvedValueOnce(
      engines('kittentts', [{ id: 'kittentts', routing_status: 'cpu_only', routing_reason: null }]),
    );
    await warnIfEngineUnderProvisioned();
    expect(toastFn).not.toHaveBeenCalled();

    onEngineSelected('omnivoice', null);

    listEnginesMock.mockResolvedValueOnce(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: VRAM_CAVEAT },
      ]),
    );
    await warnIfEngineUnderProvisioned();

    expect(listEnginesMock).toHaveBeenCalledTimes(2);
    expect(toastFn).toHaveBeenCalledTimes(1);
    expect(toastFn.mock.calls[0][0]).toContain('omnivoice');
  });

  it('does not repeat a caveat the select toast just showed', async () => {
    onEngineSelected('omnivoice', VRAM_CAVEAT);
    listEnginesMock.mockResolvedValue(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: VRAM_CAVEAT },
      ]),
    );

    await warnIfEngineUnderProvisioned();
    expect(toastFn).not.toHaveBeenCalled();
  });

  // A rejected promise cached for the full TTL silences the caveat for a
  // minute after the backend comes back.
  it('retries after a transient engine-list failure', async () => {
    listEnginesMock.mockRejectedValueOnce(new Error('backend restarting'));
    await warnIfEngineUnderProvisioned();
    expect(toastFn).not.toHaveBeenCalled();

    listEnginesMock.mockResolvedValueOnce(
      engines('omnivoice', [
        { id: 'omnivoice', routing_status: 'accelerated', routing_reason: VRAM_CAVEAT },
      ]),
    );
    await warnIfEngineUnderProvisioned();

    expect(listEnginesMock).toHaveBeenCalledTimes(2);
    expect(toastFn).toHaveBeenCalledTimes(1);
  });
});
