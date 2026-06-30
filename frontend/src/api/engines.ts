import { apiJson, apiPost } from './client';
import type {
  AllEnginesResponse,
  EngineFamily,
  EngineHealthResponse,
  SelectEngineResponse,
} from './types';

interface TranslationEngine {
  id: string;
  display_name: string;
  pip_package: string | null;
  probe_module: string | null;
  category: 'offline' | 'online' | 'llm';
  needs_key: boolean;
  builtin?: boolean;
  notes?: string;
  installed: boolean;
  availability_reason: string;
}
export interface TranslationEnginesResponse {
  engines: TranslationEngine[];
  sandboxed: boolean;
}
export interface InstallEngineResponse {
  status:
    | 'installed'
    | 'already_installed'
    | 'installed_but_probe_failed'
    | 'uninstalled'
    | 'no_op';
  engine: string;
  package?: string;
  log_tail?: string;
  restart_required?: boolean;
}

export async function listEngines(): Promise<AllEnginesResponse> {
  return apiJson<AllEnginesResponse>('/engines');
}

export async function selectEngine(
  family: EngineFamily,
  backendId: string,
): Promise<SelectEngineResponse> {
  return apiPost<SelectEngineResponse>('/engines/select', { family, backend_id: backendId });
}

/**
 * Plan 02-04 / ENGINE-06 — spawn-and-ping a SubprocessBackend (or
 * `is_available()`-check an in-process backend) on user demand. The
 * Engine Compatibility Matrix's "Test engine" button calls this; never
 * called on Settings mount to avoid auto-spawning every sidecar.
 *
 * The endpoint never 500s on a sick backend — it captures the exception
 * into the response body as `{ ok: false, message: "ExcType: ..." }`.
 * 404 is returned only when `engineId` matches none of the tts/asr/llm
 * registries.
 */
export async function getEngineHealth(engineId: string): Promise<EngineHealthResponse> {
  return apiJson<EngineHealthResponse>(`/engines/${encodeURIComponent(engineId)}/health`);
}

export async function listTranslationEngines(): Promise<TranslationEnginesResponse> {
  return apiJson<TranslationEnginesResponse>('/engines/translation');
}

export async function installTranslationEngine(id: string): Promise<InstallEngineResponse> {
  return apiPost<InstallEngineResponse>(`/engines/translation/${id}/install`, {});
}

// ── Effect presets ──────────────────────────────────────────────────────

export interface EffectPreset {
  id: string;
  label: string;
  icon: string;
  description: string;
}
