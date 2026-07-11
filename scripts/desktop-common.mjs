// ──────────────────────────────────────────────────────────────────────────
// desktop-common.mjs — pure, side-effect-free helpers shared by the local
// desktop launcher scripts (desktop-fresh.mjs today; desktop-prod.sh mirrors
// the build-command literal — see UPDATER_ARTIFACTS_OFF below).
//
// Everything in here is a pure function of its inputs so it can be unit
// tested (tests/frontend/desktopScripts.test.mjs) without touching the
// filesystem or the environment. Keep it that way: no fs, no process.env
// reads, no child_process.
// ──────────────────────────────────────────────────────────────────────────

export const APP_ID = "com.debpalash.omnivoice-studio";
export const APP_NAME = "OmniVoice Studio";

/** Backend data dir name — backend/core/config.py::get_app_data_dir() writes
 *  to "~/Library/Application Support/OmniVoice" on macOS (NOT under APP_ID). */
export const BACKEND_DIR_NAME = "OmniVoice";

/** PATH entries hidden from the app in fresh/new-user emulation: the Homebrew
 *  and /usr/local prefixes where a dev's ffmpeg/ffprobe/yt-dlp live. A real
 *  new user's machine has none of these tools on PATH. */
export const STRIPPED_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

/** Env vars hidden from the app in fresh/new-user emulation (exact names).
 *  HF_HUB_CACHE is included because backend/core/config.py honours it the
 *  same way it honours HF_HOME. */
export const STRIPPED_ENV_VARS = [
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HF_HOME",
  "HF_HUB_CACHE",
  "HF_ENDPOINT",
];

/** Env-var prefixes hidden from the app (any OMNIVOICE_* override:
 *  OMNIVOICE_DATA_DIR, OMNIVOICE_CACHE_DIR, OMNIVOICE_IDLE_TIMEOUT, …). */
export const STRIPPED_ENV_PREFIXES = ["OMNIVOICE_"];

/** Inline `tauri build --config` override for LOCAL emulation builds: skip
 *  updater artifacts (.app.tar.gz + .sig). Dev machines have no
 *  TAURI_SIGNING_PRIVATE_KEY, so with createUpdaterArtifacts left at the
 *  tauri.conf.json default (true) the build produced every bundle and THEN
 *  exited 1 at the signing step. Local emulation never needs updater
 *  artifacts — release.yml is where they are built and signed.
 *  Kept in sync with the same literal in scripts/desktop-prod.sh. */
export const UPDATER_ARTIFACTS_OFF =
  '{"bundle":{"createUpdaterArtifacts":false}}';

/**
 * Arguments for the workspace-local Tauri CLI (`bun run --cwd frontend <…>`)
 * to build a local-emulation debug bundle that exits 0:
 *   - only the bundle the launcher actually uses (macOS .app / Linux
 *     AppImage / raw .exe on Windows — no dmg/deb/msi busywork), and
 *   - no updater artifacts (see UPDATER_ARTIFACTS_OFF).
 *
 * @param {NodeJS.Platform | string} platform  e.g. process.platform
 */
export function tauriBuildArgs(platform) {
  const bundleFlags =
    platform === "darwin"
      ? ["--bundles", "app"]
      : platform === "linux"
        ? ["--bundles", "appimage"]
        : ["--no-bundle"]; // Windows launches the raw debug .exe
  return ["tauri", "build", "--debug", ...bundleFlags, "--config", UPDATER_ARTIFACTS_OFF];
}

/**
 * True when a path is unambiguously OmniVoice-scoped and therefore safe to
 * auto-delete. The HF cache defaults to the SHARED ~/.cache/huggingface on
 * macOS/Linux (backend/core/config.py only relocates it on Windows), and
 * HF_HOME can point anywhere — wiping a non-scoped path would delete models
 * unrelated to OmniVoice.
 */
export function isAppScoped(p) {
  const s = String(p).toLowerCase();
  return s.includes("omnivoice") || s.includes("com.debpalash");
}

/**
 * Every trace a past OmniVoice install leaves on macOS. Superset of what
 * desktop-prod.sh cleans; desktop-fresh.mjs removes all of it for a true
 * new-user blank slate. All paths are APP_ID / OmniVoice-scoped by
 * construction — enforced by tests/frontend/desktopScripts.test.mjs.
 *
 * `kind: "prefix"` entries match every directory entry whose basename starts
 * with the given basename (e.g. ~/Library/HTTPStorages/<APP_ID> AND
 * <APP_ID>.binarycookies).
 *
 * @param {string} home  the user's home directory (os.homedir())
 * @returns {{label: string, path: string, kind?: "prefix"}[]}
 */
export function macosFreshTraces(home) {
  return [
    // What desktop-prod.sh already cleans:
    { label: "App data (Tauri venv + state)", path: `${home}/Library/Application Support/${APP_ID}` },
    { label: "Backend data (db, voices, outputs)", path: `${home}/Library/Application Support/${BACKEND_DIR_NAME}` },
    { label: "Tauri logs", path: `${home}/Library/Logs/${APP_ID}` },
    { label: "WebKit storage (webview localStorage)", path: `${home}/Library/WebKit/${APP_ID}` },
    // Extra traces that survive a reinstall + data wipe:
    { label: "Caches", path: `${home}/Library/Caches/${APP_ID}` },
    { label: "HTTP storages (cookies, HSTS)", path: `${home}/Library/HTTPStorages/${APP_ID}`, kind: "prefix" },
    { label: "Preferences plist", path: `${home}/Library/Preferences/${APP_ID}.plist` },
    { label: "Saved application state", path: `${home}/Library/Saved Application State/${APP_ID}.savedState` },
  ];
}

/**
 * Strip the dev-tool prefixes (STRIPPED_PATH_ENTRIES) from a PATH string,
 * preserving the order of everything else. Trailing slashes on entries are
 * normalised for comparison only ("/usr/local/bin/" is stripped too);
 * look-alikes ("/usr/local/bin-extra") are preserved.
 *
 * @param {string} pathValue  a ":"-separated PATH string
 */
export function sanitizedPath(pathValue) {
  const norm = (e) => e.replace(/\/+$/, "");
  return String(pathValue)
    .split(":")
    .filter((e) => !STRIPPED_PATH_ENTRIES.includes(norm(e)))
    .join(":");
}

/**
 * Return a sanitized copy of an environment object for new-user emulation:
 * STRIPPED_ENV_VARS and STRIPPED_ENV_PREFIXES-matching keys removed, PATH
 * run through sanitizedPath(). The input object is not mutated.
 *
 * @param {Record<string, string | undefined>} env  e.g. process.env
 */
export function sanitizedEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIPPED_ENV_VARS.includes(key)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  if (out.PATH != null) out.PATH = sanitizedPath(out.PATH);
  return out;
}

/**
 * The env keys that sanitizedEnv() would remove from `env` and the PATH
 * entries it would strip — for the camouflage banner, so the tester sees
 * exactly what is hidden on THIS machine.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ vars: string[], pathEntries: string[] }}
 */
export function hiddenFrom(env) {
  const norm = (e) => e.replace(/\/+$/, "");
  const vars = Object.keys(env).filter(
    (key) =>
      STRIPPED_ENV_VARS.includes(key) ||
      STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  const pathEntries = String(env.PATH ?? "")
    .split(":")
    .filter((e) => STRIPPED_PATH_ENTRIES.includes(norm(e)));
  return { vars, pathEntries };
}
