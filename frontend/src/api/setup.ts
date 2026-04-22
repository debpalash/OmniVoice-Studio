import { API, apiJson, apiPost, apiFetch } from './client';

export interface MissingModel {
  repo_id: string;
  label: string;
}

export interface SetupStatus {
  models_ready: boolean;
  missing: MissingModel[];
  hf_cache_dir: string;
  disk_free_gb: number;
  min_free_gb: number;
  enough_disk: boolean;
}

export interface SetupProgressEvent {
  filename: string;
  downloaded: number;
  total: number;
  pct: number;
  phase: 'start' | 'progress' | 'done';
}

export async function setupStatus(): Promise<SetupStatus> {
  return apiJson<SetupStatus>('/setup/status');
}

export async function setupWarmup(): Promise<{ status: string }> {
  return apiPost<{ status: string }>('/setup/warmup');
}

export function setupDownloadStreamUrl(): string {
  return `${API}/setup/download-stream`;
}

// ── Model store ───────────────────────────────────────────────────────────

export interface KnownModel {
  repo_id: string;
  label: string;
  role: 'TTS' | 'ASR' | 'Diarisation' | string;
  size_gb: number;
  required: boolean;
  note?: string;
  installed: boolean;
  size_on_disk_bytes: number;
  nb_files: number;
}

export interface ModelList {
  models: KnownModel[];
  total_installed_bytes: number;
  hf_cache_dir: string;
}

export async function listModels(): Promise<ModelList> {
  return apiJson<ModelList>('/models');
}

export async function installModel(repo_id: string): Promise<{ status: string; repo_id: string }> {
  return apiPost('/models/install', { repo_id });
}

// ── Device-aware model recommendation ─────────────────────────────────────

export interface RecommendedModel {
  repo_id: string;
  label: string;
  role: string;
  size_gb: number;
  required: boolean;
  note: string | null;
  installed: boolean;
}

export interface Recommendations {
  device: {
    os: string;
    arch: string;
    is_mac_arm: boolean;
    is_mac_intel: boolean;
    is_linux: boolean;
    is_windows: boolean;
    has_cuda: boolean;
    label: string;
  };
  rationale: string;
  models: RecommendedModel[];
  download_gb_remaining: number;
  total_gb: number;
  all_installed: boolean;
}

export async function getRecommendations(): Promise<Recommendations> {
  return apiJson<Recommendations>('/setup/recommendations');
}

export async function deleteModel(repo_id: string): Promise<{ deleted: boolean; repo_id: string; freed_bytes: number }> {
  const r = await apiFetch(`/models/${encodeURIComponent(repo_id)}`, { method: 'DELETE' });
  return r.json();
}

// ── Pre-flight system check ───────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}

export interface PreflightDevice {
  os: string;
  arch: string;
  gpu_vendor: 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown' | 'none';
  gpu_backend: 'cuda' | 'rocm' | 'mps' | 'cpu';
  gpu_available: boolean;
  gpu_driver: string | null;
  gpu_device_name: string | null;
  ram_gb: number;
  disk_free_gb: number;
}

export interface PreflightReport {
  ok: boolean;
  has_warnings: boolean;
  checks: PreflightCheck[];
  device: PreflightDevice;
}

export async function preflight(): Promise<PreflightReport> {
  return apiJson<PreflightReport>('/setup/preflight');
}

