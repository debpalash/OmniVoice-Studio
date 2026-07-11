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
type GPUTarget = 'cuda' | 'mps' | 'rocm' | 'xpu' | 'cpu';
// Where an engine actually runs on THIS host. `network` is LLM-only (remote).
type EffectiveDevice = GPUTarget | 'network';
// `n/a` is LLM-only; resolve_routing only ever returns the first four.
type RoutingStatus = 'accelerated' | 'cpu_fallback' | 'cpu_only' | 'unavailable' | 'n/a';

interface EngineBackend {
  id: string;
  display_name: string;
  available: boolean;
  reason: string | null;
  // Available-but-has-advice: the backend's `is_available()` returned ok with
  // an advisory tail ("ready — <advice>", e.g. VoxCPM2's upgrade hint). Null
  // for plain-ready and unavailable rows; absent on legacy payloads.
  hint?: string | null;
  // Cloning capability (TTS family): true/false from the backend class, null
  // when model-dependent (mlx-audio's curated models differ). Only badge on
  // an explicit true.
  supports_cloning?: boolean | null;
  install_hint?: string | null;
  // Copy-paste-ready `export VAR=...` line for a path-gated opt-in engine
  // (IndexTTS / MOSS-v1.5 / dots.tts / Confucius4), else null/absent.
  setup_snippet?: string | null;
  // True when the backend's sidecar provisioner can install this engine
  // in-app (Settings renders an Install button; the manual snippet is
  // demoted to a collapsible fallback). Absent on legacy payloads.
  one_click_install?: boolean;
  last_error?: string | null;
  isolation_mode?: 'in-process' | 'subprocess';
  gpu_compat?: GPUTarget[];
  // Routing (#21) — the device this engine uses on this machine + why.
  effective_device?: EffectiveDevice;
  routing_status?: RoutingStatus;
  routing_reason?: string | null;
  // #981 — mlx-audio ONLY: it multiplexes 7+ curated models behind one
  // backend id, so its entry also carries the roster + current pick so
  // Settings can render a model picker. Absent on every other backend.
  curated_models?: CuratedModel[];
  active_model_id?: string;
}

// #981 — one of mlx-audio's curated models (see backend
// MLXAudioBackend.CURATED_MODELS / _MLX_AUDIO_MODEL_LABELS).
export interface CuratedModel {
  key: string;
  label: string;
  repo_id: string;
}

interface EngineFamilyResponse {
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
  // Routing verdict for the picked engine on THIS host (#21) — the select echo
  // the post-select toast reads to warn on a cpu_fallback pick. Optional so a
  // legacy payload without them still types cleanly.
  routing_status?: RoutingStatus;
  effective_device?: EffectiveDevice;
  routing_reason?: string | null;
}

export interface EngineHealthResponse {
  id: string;
  ok: boolean;
  message: string;
  latency_ms: number;
}

// Real-synthesis self-test result for an available in-process TTS engine
// (POST /engines/{id}/selftest). `ok` proves the engine emitted audio; the
// rest quantify it. `timed_out` marks a synth that outran the bounded timeout.
export interface EngineSelfTestResponse {
  id: string;
  ok: boolean;
  message: string;
  duration_ms: number;
  sample_rate?: number | null;
  num_samples?: number | null;
  audio_seconds?: number | null;
  timed_out?: boolean;
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
type ProfileKind = 'clone' | 'design';

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

// ── Portable persona bundles (.ovsvoice, #29) ──────────────────────────────
export interface PersonaImportResult {
  success: boolean;
  profile_id: string;
  name: string;
  kind: ProfileKind | string;
  verified_own_voice: boolean;
  preview_only: boolean;
  license_spdx: string;
  watermarked_preview: boolean;
  source_bundle: string;
  schema_version_ahead: boolean;
}

export interface PersonaBundleMeta {
  format: string; // "ovsvoice" | "omnivoice-legacy"
  schema_version: number;
  name: string;
  kind: ProfileKind | string;
  language?: string;
  personality?: string;
  is_locked?: boolean;
  license_spdx: string;
  tags: string[];
  preview_only: boolean;
  watermarked_preview: boolean;
  consent: null | {
    verified_claimed: boolean;
    method: string;
    has_recording: boolean;
    would_verify: boolean;
  };
  schema_version_ahead: boolean;
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
interface DubJobMeta {
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

export interface DubTranslateResponse {
  segments: {
    id: string;
    text: string;
    text_original?: string;
    rate_ratio?: number;
    rate_error?: string;
    /** Pre-synthesis duration plan (backend services/duration_planner.py). */
    plan?: {
      status: 'fits' | 'tight' | 'impossible';
      est_dur_s: number;
      available_s: number;
      est_overrun_s: number;
      calibrated: boolean;
      /** Opt-in LLM condensation suggestion (request condense=true only). */
      suggested_text?: string;
      suggested_est_dur_s?: number;
    };
  }[];
}

// ── Generic ──────────────────────────────────────────────────────────────
export interface DeletedResponse {
  deleted: boolean | number;
}
