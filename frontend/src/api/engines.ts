import { apiJson, apiPost, apiDelete } from './client';
import type {
  AllEnginesResponse,
  EngineFamily,
  EngineFamilyResponse,
  SelectEngineResponse,
} from './types';

export interface TranslationEngine {
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
  status: 'installed' | 'already_installed' | 'installed_but_probe_failed' | 'uninstalled' | 'no_op';
  engine: string;
  package?: string;
  log_tail?: string;
  restart_required?: boolean;
}

export async function listEngines(): Promise<AllEnginesResponse> {
  return apiJson<AllEnginesResponse>('/engines');
}

export async function listTtsBackends(): Promise<EngineFamilyResponse> {
  return apiJson<EngineFamilyResponse>('/engines/tts');
}
export async function listAsrBackends(): Promise<EngineFamilyResponse> {
  return apiJson<EngineFamilyResponse>('/engines/asr');
}
export async function listLlmBackends(): Promise<EngineFamilyResponse> {
  return apiJson<EngineFamilyResponse>('/engines/llm');
}

export async function selectEngine(family: EngineFamily, backendId: string): Promise<SelectEngineResponse> {
  return apiPost<SelectEngineResponse>('/engines/select', { family, backend_id: backendId });
}

export async function listTranslationEngines(): Promise<TranslationEnginesResponse> {
  return apiJson<TranslationEnginesResponse>('/engines/translation');
}

export async function installTranslationEngine(id: string): Promise<InstallEngineResponse> {
  return apiPost<InstallEngineResponse>(`/engines/translation/${id}/install`, {});
}

export async function uninstallTranslationEngine(id: string): Promise<InstallEngineResponse> {
  const res = await apiDelete(`/engines/translation/${id}`);
  return (await res.json()) as InstallEngineResponse;
}

export interface JobsQuery {
  status?: string;
  projectId?: string;
  limit?: number;
}

export async function listJobs({ status, projectId, limit = 100 }: JobsQuery = {}): Promise<unknown> {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (projectId) qs.set('project_id', projectId);
  qs.set('limit', String(limit));
  return apiJson(`/jobs?${qs.toString()}`);
}

export async function getJob(id: string): Promise<unknown> {
  return apiJson(`/jobs/${id}`);
}

export async function getJobEvents(id: string, afterSeq: number = 0): Promise<unknown> {
  return apiJson(`/jobs/${id}/events?after_seq=${afterSeq}`);
}
