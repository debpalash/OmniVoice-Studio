import { apiJson, apiFetch, apiPost } from './client';

export async function sysinfo() {
  return apiJson('/sysinfo');
}

export async function modelStatus() {
  return apiJson('/model/status');
}

export async function cleanAudio(formData) {
  // Returns Response because caller needs blob body + X-Clean-Filename header.
  return apiFetch('/clean-audio', { method: 'POST', body: formData });
}

export async function systemInfo() {
  return apiJson('/system/info');
}

export async function systemLogs(tail = 300) {
  return apiJson(`/system/logs?tail=${tail}`);
}

export async function systemLogsTauri(tail = 300) {
  return apiJson(`/system/logs/tauri?tail=${tail}`);
}

export async function clearSystemLogs() {
  return apiPost('/system/logs/clear');
}
