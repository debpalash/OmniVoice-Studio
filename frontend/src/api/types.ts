/**
 * Shared response shapes for the API layer (Phase 2.3).
 *
 * Keep these close to the wire — they mirror backend pydantic schemas. When
 * the backend adds a field, add it here first and the TS compiler will flag
 * every consumer that needs to handle it.
 *
 * When a shape is still evolving, leave it `Record<string, unknown>` rather
 * than lying with a fake type — explicit "unknown" prompts a runtime check.
 */

// ── Engines (Phase 3 / 4.6 / Plan 02-04) ─────────────────────────────────
export type EngineFamily = 'tts' | 'asr' | 'llm';

// `isolation_mode`, `last_error`, `install_hint`, `gpu_compat` arrived in Plan
// 02-04 alongside the Engine Compatibility Matrix. As of #21 ALL three
// registries (tts / asr / llm) emit the full shape, plus the routing trio
// (`effective_device` / `routing_status` / `routing_reason`). They stay
// optional so the matrix still renders a legacy/older payload that omits them
// (it gates with `??` / `?.length` and suppresses the routing badge).
export type GPUTarget = 'cuda' | 'mps' | 'rocm' | 'xpu' | 'cpu';
// Where an engine actually runs on THIS host. `network` is LLM-only (remote).
export type EffectiveDevice = GPUTarget | 'network';
// `n/a` is LLM-only; resolve_routing only ever returns the first four.
export type RoutingStatus =
  | 'accelerated' | 'cpu_fallback' | 'cpu_only' | 'unavailable' | 'n/a';

export interface EngineBackend {
  id: string;
  display_name: string;
  available: boolean;
  reason: string | null;
  install_hint?: string | null;
  last_error?: string | null;
  isolation_mode?: 'in-process' | 'subprocess';
  gpu_compat?: GPUTarget[];
  // Routing (#21) — the device this engine uses on this machine + why.
  effective_device?: EffectiveDevice;
  routing_status?: RoutingStatus;
  routing_reason?: string | null;
}

export interface EngineFamilyResponse {
  active: string;
  backends: EngineBackend[];
}

export interface AllEnginesResponse {
  tts: EngineFamilyResponse;
  asr: EngineFamilyResponse;
  llm: EngineFamilyResponse;
}

export interface SelectEngineResponse {
  family: EngineFamily;
  active: string;
  env_override: boolean;
}

export interface EngineHealthResponse {
  id: string;
  ok: boolean;
  message: string;
  latency_ms: number;
}

// ── System / diagnostics ─────────────────────────────────────────────────
export interface SystemInfo {
  app_version?: string;
  python?: string;
  platform?: string;
  arch?: string;
  device?: string;
  data_dir?: string;
  outputs_dir?: string;
  model_checkpoint?: string;
  asr_model?: string;
  translate_provider?: string;
  idle_timeout_seconds?: number;
  has_hf_token?: boolean;
}

export interface ModelStatus {
  status: 'idle' | 'loading' | 'ready' | string;
  checkpoint?: string;
  loaded_at?: string;
}

export interface LogsResponse {
  path: string;
  exists: boolean;
  lines: string[];
  candidates?: string[];
}

export interface ClearTauriResponse {
  cleared: string[];
}

// ── Projects ─────────────────────────────────────────────────────────────
export interface ProjectSummary {
  id: string;
  name: string;
  updated_at: string;
  created_at: string;
  language_code?: string;
}

export interface ProjectDetail extends ProjectSummary {
  segHashes?: Record<string, string>;
  state_json?: string;
  [key: string]: unknown;
}

// ── Profiles (voice library) ─────────────────────────────────────────────
export type ProfileKind = 'clone' | 'design';

export interface Profile {
  id: string;
  name: string;
  kind: ProfileKind;
  language_code?: string;
  ref_audio?: string;
  ref_text?: string;
  description?: string;
  created_at?: string;
  is_locked?: boolean;
  /** Consent lock (Wave 0.2): owner recorded a spoken consent statement. */
  verified_own_voice?: boolean | number;
  consent_text?: string;
  consent_recorded_at?: number | null;
}

export interface ProfileUsage {
  projects: { project_id: string; project_name: string; segment_count: number }[];
  total_segments: number;
}

// ── Glossary ─────────────────────────────────────────────────────────────
export interface GlossaryTerm {
  id: number;
  source: string;
  target: string;
  source_lang?: string;
  target_lang?: string;
  auto?: boolean;
  notes?: string;
}

export interface AutoExtractResponse {
  added: GlossaryTerm[];
  skipped: number;
}

// ── Dub pipeline ─────────────────────────────────────────────────────────
export interface DubJobMeta {
  id: string;
  status: string;
  filename?: string;
  language_code?: string;
  dubbed_tracks?: Record<string, string>;
  created_at?: string;
  seg_hashes?: Record<string, string>;
}

export interface DubHistoryResponse {
  jobs: DubJobMeta[];
}

export interface DubSegment {
  start: number;
  end: number;
  text: string;
  instruct?: string;
  profile_id?: string;
  speed?: number;
  gain?: number;
  target_lang?: string;
  effect_preset?: string;
}

export interface DubTranslateResponse {
  segments: { id: string; text: string; text_original?: string; rate_ratio?: number; rate_error?: string }[];
}

// ── Generic ──────────────────────────────────────────────────────────────
export interface DeletedResponse {
  deleted: boolean | number;
}
