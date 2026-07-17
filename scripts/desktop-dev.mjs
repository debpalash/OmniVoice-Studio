#!/usr/bin/env bun
// ──────────────────────────────────────────────────────────────────────────
// desktop-dev.mjs — launch `tauri dev` with a self-healing PATH.
//
// Why this exists: `tauri dev` shells out to `cargo`. On Windows especially, a
// terminal opened *before* rustup was installed keeps a stale PATH snapshot
// that lacks `~/.cargo/bin`, so `bun desktop` dies with
//     failed to run 'cargo metadata' command … program not found
// even though cargo IS installed and IS on the persisted User PATH — a brand
// new terminal would find it. Rather than make every contributor remember to
// reopen their shell, prepend the standard rustup bin dir here when cargo isn't
// already resolvable. Cross-platform (`~/.cargo/bin` on macOS/Linux/Windows)
// and a complete no-op when cargo is already on PATH, so nothing changes for
// anyone whose environment is already correct.
//
// Invoked as the frontend `desktop` script (`bun ../scripts/desktop-dev.mjs`),
// so cwd is frontend/ and `bun run tauri dev` resolves the workspace-local
// @tauri-apps/cli. All extra args are forwarded untouched.
// ──────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

/** The env's PATH key — Windows uses "Path", others "PATH"; match case-insensitively. */
function pathKeyOf(env) {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

/** Is `cargo` resolvable via the given env's PATH? Uses a child that searches
 *  its own PATH (`cmd`/`sh`), which mirrors how the Tauri CLI's Rust resolves
 *  `cargo` downstream — unlike Bun's own launcher resolution, which snapshots
 *  PATH and would give a false negative after we heal it. */
function cargoResolvable(env) {
  const probe =
    process.platform === "win32"
      ? spawnSync("cmd", ["/c", "cargo --version"], { env, stdio: "ignore" })
      : spawnSync("sh", ["-c", "command -v cargo"], { env, stdio: "ignore" });
  return probe.status === 0;
}

// Start from the real environment; heal a stale PATH into a *copy* (mutating
// process.env doesn't reliably propagate to children under Bun).
const childEnv = { ...process.env };
const key = pathKeyOf(childEnv);

if (!cargoResolvable(childEnv)) {
  const cargoBin = join(homedir(), ".cargo", "bin");
  const cargoExe = join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
  if (existsSync(cargoExe)) {
    childEnv[key] = cargoBin + delimiter + (childEnv[key] ?? "");
    console.log(
      `[desktop-dev] added '${cargoBin}' to PATH for this run - cargo is installed but wasn't visible to ` +
        `this terminal (a stale PATH from before rustup). Open a new terminal to make it permanent.`,
    );
  } else {
    console.error(
      [
        "",
        "❌ `tauri dev` needs Rust/cargo, and none was found.",
        "",
        "   Install the Rust toolchain, then reopen your terminal:",
        "     Windows:      winget install Rust.Rustup",
        "     macOS/Linux:  https://rustup.rs",
        "",
        "   Or download a prebuilt installer from the Releases page (no toolchain needed).",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}

// Run the workspace-local Tauri CLI in dev mode (cwd is already frontend/),
// handing it the healed env so its `cargo` spawns inherit the fixed PATH.
const res = spawnSync("bun", ["run", "tauri", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: childEnv,
});
if (res.error) {
  console.error(`❌ failed to launch tauri dev: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
