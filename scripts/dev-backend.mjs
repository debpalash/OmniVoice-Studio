// ──────────────────────────────────────────────────────────────────────────
// dev-backend.mjs — `bun run dev:api` wrapper that makes a backend death
// LOUD instead of silent (#1164).
//
// In dev, the backend has no supervisor: concurrently's --kill-others-on-fail
// tears the whole dev stack down the moment uvicorn exits, and the only
// trace of WHY was whatever scrolled past in the terminal — the browser tab
// just showed "Can't reach the local VoiceStudio backend". This wrapper spawns
// the exact same uvicorn command (args identical to the old dev:api script)
// with inherited stdio, and when the child dies with a non-zero exit — and
// the developer didn't Ctrl+C — it prints a boxed banner with:
//   - the exit code / signal,
//   - the last 20 lines of omnivoice.log (resolved like
//     backend/core/config.py::get_app_data_dir),
//   - an OOM-check hint on Linux (journalctl -k), and
//   - a pointer to the crash notice the run sentinel will raise on the next
//     backend start.
// It exits with the child's own code so --kill-others-on-fail still works.
//
// Runs under bun and node alike; cross-platform (uv resolves to uv.exe via
// the Windows CreateProcess PATH search — no shell needed).
// ──────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Keep these args byte-identical to the previous root package.json dev:api.
export const UVICORN_ARGS = [
  "run",
  "uvicorn",
  "main:app",
  "--app-dir",
  "backend",
  "--host",
  "0.0.0.0",
  "--port",
  "3900",
  "--reload",
  "--reload-dir",
  "backend",
];

/** Mirror backend/core/config.py::get_app_data_dir() so the banner reads the
 *  same omnivoice.log the backend writes. Pure — testable with fake inputs. */
export function resolveDataDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.OMNIVOICE_DATA_DIR) return env.OMNIVOICE_DATA_DIR;
  if (platform === "darwin") return path.join(home, "Library/Application Support/OmniVoice");
  if (platform === "win32") return path.join(env.APPDATA || "", "OmniVoice");
  return path.join(home, ".omnivoice");
}

/** Last `n` lines of a file, or null when unreadable. Pure-ish (fs read). */
export function tailFile(filePath, n = 20) {
  try {
    if (!existsSync(filePath)) return null;
    const lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n).join("\n");
  } catch {
    return null;
  }
}

/** The banner text (pure, testable). `code`/`signal` from the child's exit. */
export function buildExitBanner({ code, signal, logTail, logPath, platform = process.platform }) {
  const bar = "═".repeat(74);
  const how = signal ? `killed by signal ${signal}` : `exit code ${code}`;
  const lines = [
    "",
    `╔${bar}╗`,
    "║  OMNIVOICE BACKEND DIED — this is why the UI says it can't reach it.",
    `║  uvicorn ended with ${how}.`,
    "╚" + bar + "╝",
    "",
  ];
  if (logTail) {
    lines.push(`Last 20 lines of ${logPath}:`, "─".repeat(76), logTail, "─".repeat(76), "");
  } else {
    lines.push(`(no omnivoice.log found at ${logPath} — the backend may have died before logging)`, "");
  }
  if (signal === "SIGKILL" || code === 137) {
    lines.push(
      "SIGKILL usually means the operating system's out-of-memory killer stopped it.",
    );
  }
  if (platform === "linux") {
    lines.push("If you suspect an OOM kill, check:  journalctl -k | grep -i oom", "");
  }
  lines.push(
    "This death will also be reported as a crash notice in the UI the next time",
    "the backend starts (run sentinel, see docs/install/troubleshooting.md).",
    "",
  );
  return lines.join("\n");
}

// `uv run` re-syncs the venv to uv.lock before launching — which would undo
// the opt-in ROCm torch swap `scripts/setup.py` just performed (the lock pins
// the CUDA build). `bun run setup:api` already did the sync, so skip it here
// whenever the ROCm variant is requested (#1665).
export function uvRunArgs(env = process.env) {
  const rocm = (env.OMNIVOICE_TORCH_VARIANT || "").trim().toLowerCase() === "rocm";
  return rocm ? [UVICORN_ARGS[0], "--no-sync", ...UVICORN_ARGS.slice(1)] : UVICORN_ARGS;
}

function main() {
  const child = spawn("uv", uvRunArgs(), { stdio: "inherit" });

  // A Ctrl+C / concurrently teardown is a DELIBERATE stop — no scary banner.
  let interrupted = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        interrupted = true;
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      });
    } catch {
      /* signal unsupported on this platform (e.g. SIGHUP on Windows) */
    }
  }

  child.on("error", (err) => {
    console.error(`[dev-backend] could not start uv: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (!interrupted && (signal || (code !== 0 && code != null))) {
      const dataDir = resolveDataDir();
      const logPath = path.join(dataDir, "omnivoice.log");
      console.error(
        buildExitBanner({ code, signal, logTail: tailFile(logPath, 20), logPath }),
      );
    }
    // Preserve concurrently's --kill-others-on-fail semantics: propagate the
    // child's outcome exactly (128+n is the conventional signal-death code).
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

// Import-safe: tests import the pure helpers without spawning anything.
// fileURLToPath (not URL.pathname) so the comparison also holds on Windows,
// where pathname yields "/C:/…" but argv[1] is "C:\…".
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
