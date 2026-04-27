import { apiJson, apiFetch, apiPost } from './client';
import type { SystemInfo, ModelStatus, LogsResponse, ClearTauriResponse } from './types';

// ── Tauri IPC helpers ────────────────────────────────────────────────────
// Try native Tauri invoke() first — it's faster (no HTTP round-trip) and
// works when the Python backend is still booting. Falls back to HTTP when
// running in browser dev mode (no Tauri shell).

let _invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (_invoke !== null) return _invoke;
  try {
    const mod = await import('@tauri-apps/api/core');
    _invoke = mod.invoke;
    return _invoke;
  } catch {
    // Not running inside Tauri (browser dev mode)
    _invoke = null as any;
    return null;
  }
}

/** Try Tauri invoke, fall back to HTTP. */
async function invokeOrFetch<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  httpFallback: () => Promise<T>,
): Promise<T> {
  try {
    const invoke = await getInvoke();
    if (invoke) {
      return (await invoke(command, args)) as T;
    }
  } catch {
    // invoke failed — fall through to HTTP
  }
  return httpFallback();
}

// ── System info (polled every 5s) ────────────────────────────────────────

export interface SysinfoData {
  cpu: number;
  ram: number;
  total_ram: number;
  vram: number;
  gpu_active: boolean;
}

// Cache VRAM from Python — it changes much slower than CPU/RAM, so we
// only refresh it every 15s instead of every 5s poll cycle.
let _vramCache: { vram: number; gpu_active: boolean; ts: number } | null = null;
const VRAM_CACHE_TTL = 15_000;

export async function sysinfo(): Promise<SysinfoData> {
  // Rust provides CPU + RAM; VRAM stays at 0. We merge with the Python
  // endpoint to get GPU data when available.
  const rustData = await invokeOrFetch<SysinfoData>(
    'get_sysinfo',
    undefined,
    () => apiJson<SysinfoData>('/sysinfo'),
  );

  // If we got data from Rust (vram=0), enrich with Python's VRAM data
  // but only re-fetch every 15s to avoid hammering the backend.
  if (rustData.vram === 0) {
    const now = Date.now();
    if (!_vramCache || now - _vramCache.ts > VRAM_CACHE_TTL) {
      try {
        const pyData = await apiJson<SysinfoData>('/sysinfo');
        _vramCache = { vram: pyData.vram, gpu_active: pyData.gpu_active, ts: now };
      } catch {
        // Python backend not ready yet — return Rust-only data
        return rustData;
      }
    }
    return {
      ...rustData,
      vram: _vramCache.vram,
      gpu_active: _vramCache.gpu_active,
    };
  }
  return rustData;
}

// ── Model status ─────────────────────────────────────────────────────────

export async function modelStatus(): Promise<ModelStatus> {
  return apiJson<ModelStatus>('/model/status');
}

// ── Audio cleaning ───────────────────────────────────────────────────────

export async function cleanAudio(formData: FormData): Promise<Response> {
  // Returns Response because caller needs blob body + X-Clean-Filename header.
  return apiFetch('/clean-audio', { method: 'POST', body: formData });
}

// ── System info (one-shot, for Settings) ─────────────────────────────────

export async function systemInfo(): Promise<SystemInfo> {
  return apiJson<SystemInfo>('/system/info');
}

// ── Logs (polled every 5s) ───────────────────────────────────────────────

export async function systemLogs(tail: number = 300): Promise<LogsResponse> {
  return invokeOrFetch<LogsResponse>(
    'read_log_tail',
    { source: 'backend', tail },
    () => apiJson<LogsResponse>(`/system/logs?tail=${tail}`),
  );
}

export async function systemLogsTauri(tail: number = 300): Promise<LogsResponse> {
  return invokeOrFetch<LogsResponse>(
    'read_log_tail',
    { source: 'tauri', tail },
    () => apiJson<LogsResponse>(`/system/logs/tauri?tail=${tail}`),
  );
}

// ── Log clearing ─────────────────────────────────────────────────────────

export async function clearSystemLogs(): Promise<unknown> {
  return apiPost('/system/logs/clear');
}

export async function clearTauriLogs(): Promise<ClearTauriResponse> {
  return apiPost<ClearTauriResponse>('/system/logs/tauri/clear');
}

// ── Memory flush ─────────────────────────────────────────────────────────

export async function flushMemory(unloadModel: boolean = false): Promise<unknown> {
  return apiPost(`/system/flush-memory?unload_model=${unloadModel}`);
}
