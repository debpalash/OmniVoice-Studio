#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// desktop-prod.mjs — Cross-platform launcher for scripts/desktop-prod.sh
//
// Why this exists (issue #282): `bun run desktop-prod` used to invoke
// `bash scripts/desktop-prod.sh` directly. On Windows, cmd/PowerShell have
// no `bash` on PATH unless Git for Windows put one there, so the script
// died with a cryptic spawn failure before printing anything useful.
//
// This launcher:
//   • on macOS/Linux: runs the bash script unchanged (bash is always there)
//   • on Windows: locates Git Bash (where.exe, then well-known install
//     paths, then next to git.exe) and runs the script through it —
//     deliberately skipping C:\Windows\System32\bash.exe, which is the WSL
//     launcher and would execute the script inside Linux, not Windows
//   • if no usable bash exists: prints a clear, actionable error instead
//     of a spawn failure
//
// All flags are forwarded untouched (--skip-build, --keep-data, --pill, …).
// Works under both `node` and `bun`.
// ──────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const shellScript = join(scriptDir, "desktop-prod.sh");
const args = process.argv.slice(2);
const isWindows = process.platform === "win32";

/** WSL's bash.exe lives under System32 — running the script there would
 *  detect "Linux" and wipe/launch the wrong paths. Never use it. */
function isWslBash(p) {
  return /[\\/]windows[\\/]system32[\\/]/i.test(p);
}

/** Locate a usable bash on Windows: PATH first, then well-known Git for
 *  Windows install locations, then derived from git.exe's own location. */
function findWindowsBash() {
  // 1. `where.exe bash` — respects PATH (covers MSYS2, custom installs).
  const where = spawnSync("where.exe", ["bash"], { encoding: "utf8" });
  if (where.status === 0 && where.stdout) {
    for (const line of where.stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate && !isWslBash(candidate) && existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // 2. Well-known Git for Windows install paths.
  const roots = [
    process.env.ProgramFiles, // C:\Program Files
    process.env["ProgramFiles(x86)"], // C:\Program Files (x86)
    process.env.LocalAppData
      ? join(process.env.LocalAppData, "Programs")
      : null, // per-user winget/scoop-style install
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = join(root, "Git", "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }

  // 3. git.exe is on PATH but bash isn't — derive Git Bash from its home
  //    (<git-root>\cmd\git.exe → <git-root>\bin\bash.exe).
  const whereGit = spawnSync("where.exe", ["git"], { encoding: "utf8" });
  if (whereGit.status === 0 && whereGit.stdout) {
    for (const line of whereGit.stdout.split(/\r?\n/)) {
      const gitPath = line.trim();
      if (!gitPath) continue;
      const candidate = resolve(dirname(gitPath), "..", "bin", "bash.exe");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function failNoBash() {
  console.error(
    [
      "",
      "❌ `desktop-prod` needs bash, and no usable bash was found on this system.",
      "",
      "   The from-source production launcher (scripts/desktop-prod.sh) is a bash",
      "   script. On Windows it runs through Git Bash, which ships with Git for",
      "   Windows. Pick one of these:",
      "",
      "   1. Install Git for Windows (includes Git Bash), then re-run:",
      "        winget install --id Git.Git -e",
      "        bun run desktop-prod",
      "",
      "   2. Use the dev-mode launcher instead (no bash needed):",
      "        bun run desktop",
      "",
      "   3. Skip building from source — download the installer:",
      "        https://github.com/debpalash/OmniVoice-Studio/releases/latest",
      "",
      "   More help: docs/install/windows.md",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

let result;
if (isWindows) {
  const bash = findWindowsBash();
  if (!bash) failNoBash();
  // Git Bash understands Windows paths, but forward slashes are safest.
  result = spawnSync(bash, [shellScript.replace(/\\/g, "/"), ...args], {
    stdio: "inherit",
  });
} else {
  // macOS / Linux: bash is part of the base system.
  result = spawnSync("bash", [shellScript, ...args], { stdio: "inherit" });
}

if (result.error) {
  if (result.error.code === "ENOENT") failNoBash();
  console.error(`❌ Failed to launch desktop-prod: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
