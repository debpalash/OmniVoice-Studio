// ── TanStack Query hooks ─────────────────────────────────────────────────
// Central place for all query/mutation hooks. Components import from here
// instead of calling api/* + useEffect + useState manually.
// Deduplication is automatic — two components using useSysinfo() share one
// network request and one cache entry.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as systemApi from './system';
import * as setupApi from './setup';
import * as galleryApi from './gallery';

// ── Keys (prevents typos, enables targeted invalidation) ─────────────────
export const queryKeys = {
  sysinfo:         ['sysinfo']         as const,
  modelStatus:     ['model-status']    as const,
  systemInfo:      ['system-info']     as const,
  systemLogs:      (tail?: number) => ['system-logs', tail ?? 300] as const,
  tauriLogs:       (tail?: number) => ['tauri-logs',  tail ?? 300] as const,
  models:          ['models']          as const,
  recommendations: ['recommendations'] as const,
  preflight:       ['preflight']       as const,
  setupStatus:     ['setup-status']    as const,
  galleryVoices:   (params?: any) => ['gallery-voices', params] as const,
  galleryCategories: ['gallery-categories'] as const,
};

// ── Polling queries (sysinfo, model status, logs) ────────────────────────

export function useSysinfo(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sysinfo,
    queryFn: systemApi.sysinfo,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    retry: Infinity,
    retryDelay: 1_500,
    enabled,
  });
}

export function useModelStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.modelStatus,
    queryFn: systemApi.modelStatus,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: Infinity,
    retryDelay: 1_500,
    enabled,
  });
}

export function useSystemLogs(tail = 300, enabled = true) {
  return useQuery({
    queryKey: queryKeys.systemLogs(tail),
    queryFn: () => systemApi.systemLogs(tail),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useTauriLogs(tail = 300, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tauriLogs(tail),
    queryFn: () => systemApi.systemLogsTauri(tail),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}

// ── One-shot queries ─────────────────────────────────────────────────────

export function useSystemInfo() {
  return useQuery({
    queryKey: queryKeys.systemInfo,
    queryFn: systemApi.systemInfo,
    staleTime: 60_000,
    retry: Infinity,
    retryDelay: 2_000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: setupApi.listModels,
    staleTime: 30_000,
  });
}

export function useRecommendations() {
  return useQuery({
    queryKey: queryKeys.recommendations,
    queryFn: setupApi.getRecommendations,
    staleTime: 30_000,
  });
}

export function usePreflight() {
  return useQuery({
    queryKey: queryKeys.preflight,
    queryFn: setupApi.preflight,
    staleTime: 60_000,
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: setupApi.setupStatus,
    staleTime: 10_000,
  });
}

export function useGalleryCategories() {
  return useQuery({
    queryKey: queryKeys.galleryCategories,
    queryFn: galleryApi.listCategories,
    staleTime: 60_000,
  });
}

export function useGalleryVoices(params?: any) {
  return useQuery({
    queryKey: queryKeys.galleryVoices(params),
    queryFn: () => galleryApi.listGalleryVoices(params),
    staleTime: 30_000,
  });
}

// ── Mutations ────────────────────────────────────────────────────────────

export function useInstallModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repo_id: string) => setupApi.installModel(repo_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.models });
      qc.invalidateQueries({ queryKey: queryKeys.setupStatus });
      qc.invalidateQueries({ queryKey: queryKeys.recommendations });
    },
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repo_id: string) => setupApi.deleteModel(repo_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.models });
      qc.invalidateQueries({ queryKey: queryKeys.setupStatus });
      qc.invalidateQueries({ queryKey: queryKeys.recommendations });
    },
  });
}

export function useFlushMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (unloadModel: boolean) => systemApi.flushMemory(unloadModel),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.sysinfo });
      qc.invalidateQueries({ queryKey: queryKeys.modelStatus });
    },
  });
}

export function useClearLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => systemApi.clearSystemLogs(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.systemLogs() });
    },
  });
}

export function useClearTauriLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => systemApi.clearTauriLogs(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tauriLogs() });
    },
  });
}
