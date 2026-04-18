import { apiJson, apiPost, apiFetch } from './client';

export async function listExportHistory() {
  return apiJson('/export/history');
}

export async function exportAction(body) {
  return apiPost('/export', body);
}

export async function exportReveal(body) {
  return apiPost('/export/reveal', body);
}

export async function exportRecord(body) {
  return apiPost('/export/record', body);
}
