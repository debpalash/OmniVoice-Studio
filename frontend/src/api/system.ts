import { apiJson, apiFetch, apiPost } from './client';
import type { SystemInfo, ModelStatus, LogsResponse, ClearTauriResponse } from './types';

export async function sysinfo(): Promise<SystemInfo> {
  return apiJson<SystemInfo>('/sysinfo');
}

export async function modelStatus(): Promise<ModelStatus> {
  return apiJson<ModelStatus>('/model/status');
}

export async function cleanAudio(formData: FormData): Promise<Response> {
  // Returns Response because caller needs blob body + X-Clean-Filename header.
  return apiFetch('/clean-audio', { method: 'POST', body: formData });
}

export async function systemInfo(): Promise<SystemInfo> {
  return apiJson<SystemInfo>('/system/info');
}

export async function systemLogs(tail: number = 300): Promise<LogsResponse> {
  return apiJson<LogsResponse>(`/system/logs?tail=${tail}`);
}

export async function systemLogsTauri(tail: number = 300): Promise<LogsResponse> {
  return apiJson<LogsResponse>(`/system/logs/tauri?tail=${tail}`);
}

export async function clearSystemLogs(): Promise<unknown> {
  return apiPost('/system/logs/clear');
}

export async function clearTauriLogs(): Promise<ClearTauriResponse> {
  return apiPost<ClearTauriResponse>('/system/logs/tauri/clear');
}

export async function flushMemory(unloadModel: boolean = false): Promise<unknown> {
  return apiPost(`/system/flush-memory?unload_model=${unloadModel}`);
}
