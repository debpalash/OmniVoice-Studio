import { apiJson, apiPost } from './client';
import type {
  AllEnginesResponse,
  EngineFamily,
  EngineFamilyResponse,
  SelectEngineResponse,
} from './types';

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
