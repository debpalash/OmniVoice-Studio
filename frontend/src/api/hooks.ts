// ── TanStack Query hooks ─────────────────────────────────────────────────
// Central place for all query/mutation hooks. Components import from here
// instead of calling api/* + useEffect + useState manually.
// Deduplication is automatic — two components using useSysinfo() share one
// network request and one cache entry.

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import * as systemApi from './system';
import * as setupApi from './setup';
import * as galleryApi from './gallery';
import * as archetypesApi from './archetypes';
import type { ArchetypeFilters } from './archetypes';
import * as communityApi from './community';
import type { CommunityFilters } from './community';

// ── Keys (prevents typos, enables targeted invalidation) ─────────────────
export const queryKeys = {
  sysinfo:         ['sysinfo']         as const,
  modelStatus:     ['model-status']    as const,
  notifications:   ['notifications']   as const,
  systemInfo:      ['system-info']     as const,
  systemLogs:      (tail?: number) => ['system-logs', tail ?? 300] as const,
  tauriLogs:       (tail?: number) => ['tauri-logs',  tail ?? 300] as const,
  models:          ['models']          as const,
  recommendations: ['recommendations'] as const,
  preflight:       ['preflight']       as const,
  setupStatus:     ['setup-status']    as const,
  galleryVoices:   (params?: any) => ['gallery-voices', params] as const,
  galleryCategories: ['gallery-categories'] as const,
  archetypeCategories: ['archetype-categories'] as const,
  archetypes:      (filters?: any) => ['archetypes', filters] as const,
  communityItems:  (filters?: any) => ['community-items', filters] as const,
  communityManifest: (refresh?: boolean) => ['community-manifest', !!refresh] as const,
};

// ── Polling queries (sysinfo, model status, logs) ────────────────────────

export function useSysinfo(enabled = true) {
  return useQuery({
    queryKey: queryKeys.sysinfo,
    queryFn: systemApi.sysinfo,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: Infinity,
    retryDelay: 1_500,
    enabled,
  });
}

export function useModelStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.modelStatus,
    queryFn: systemApi.modelStatus,
    // Poll every 2s while model is loading for near-real-time sub-stage
    // updates in the floating pill; 10s when idle/ready to save bandwidth.
    refetchInterval: (query) => {
      const status = query.state?.data?.status;
      return status === 'loading' ? 2_000 : 10_000;
    },
    refetchIntervalInBackground: false,
    retry: Infinity,
    retryDelay: 1_500,
    enabled,
  });
}

// Shared by the header bell (NotificationPanel) and the LogsFooter
// notifications tab — one request, one cache entry.
export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: systemApi.systemNotifications,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: Infinity,
    retryDelay: 1_500,
    enabled,
  });
}

export function useSystemLogs(tail = 300, enabled = true, refetchInterval = 10_000) {
  return useQuery({
    queryKey: queryKeys.systemLogs(tail),
    queryFn: () => systemApi.systemLogs(tail),
    refetchInterval,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export function useTauriLogs(tail = 300, enabled = true, refetchInterval = 10_000) {
  return useQuery({
    queryKey: queryKeys.tauriLogs(tail),
    queryFn: () => systemApi.systemLogsTauri(tail),
    refetchInterval,
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

// ── Archetype gallery (designed voices) ──────────────────────────────────
// The catalog is large and static, so cache it hard.
export function useArchetypeCategories() {
  return useQuery({
    queryKey: queryKeys.archetypeCategories,
    queryFn: archetypesApi.listArchetypeCategories,
    staleTime: 5 * 60_000,
  });
}

export function useArchetypes(filters: ArchetypeFilters = {}) {
  return useQuery({
    queryKey: queryKeys.archetypes(filters),
    queryFn: () => archetypesApi.listArchetypes(filters),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData, // v5: keep prior page visible while paginating
  });
}

// ── Community gallery (marketplace) ───────────────────────────────────────
export function useCommunityItems(filters: CommunityFilters = {}) {
  return useQuery({
    queryKey: queryKeys.communityItems(filters),
    queryFn: () => communityApi.listCommunityItems(filters),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useCommunityManifest(refresh = false) {
  return useQuery({
    queryKey: queryKeys.communityManifest(refresh),
    queryFn: () => communityApi.communityManifest(refresh),
    staleTime: 5 * 60_000,
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
