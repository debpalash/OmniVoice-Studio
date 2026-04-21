import { apiJson, apiPost } from './client';

export async function listExportHistory(): Promise<unknown> {
  return apiJson('/export/history');
}

export async function exportAction(body: Record<string, unknown>): Promise<unknown> {
  return apiPost('/export', body);
}

export async function exportReveal(body: Record<string, unknown>): Promise<unknown> {
  return apiPost('/export/reveal', body);
}

export async function exportRecord(body: Record<string, unknown>): Promise<unknown> {
  return apiPost('/export/record', body);
}
