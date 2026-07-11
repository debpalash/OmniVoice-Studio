#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// desktop-fresh.mjs — true NEW-USER emulation for OmniVoice Studio (macOS)
//
// Stricter sibling of `bun desktop-prod`. Two things beyond what prod does:
//
//   1. COMPLETE blank slate — removes every trace a past install leaves on
//      macOS, not just app/backend data: WebKit storage (webview
//      localStorage survives a reinstall + data wipe — bugs hiding there are
//      invisible to desktop-prod), Caches, HTTPStorages, the Preferences
//      plist (+ `defaults delete`, since cfprefsd caches beyond the file),
//      and Saved Application State.
//
//   2. DEV-MACHINE CAMOUFLAGE — launches the app with a sanitized
//      environment so it behaves like a non-developer machine: PATH without
//      /opt/homebrew/bin, /opt/homebrew/sbin, /usr/local/bin (no brew
//      ffmpeg/ffprobe/yt-dlp), and HF_TOKEN / HUGGING_FACE_HUB_TOKEN /
//      HF_HOME / HF_HUB_CACHE / HF_ENDPOINT / OMNIVOICE_* unset.
//
//      Env propagation: the app is launched by DIRECT EXEC of the bundle's
//      Mach-O (Contents/MacOS/omnivoice-studio), which inherits our env.
//      `open` (what desktop-prod uses) hands off to LaunchServices/launchd,
//      which starts the app with launchd's environment — the sanitized env
//      would be silently ignored.
//
//      Known limitation: backend/core/config.py re-prepends /opt/homebrew/bin
//      and /usr/local/bin to the backend's own PATH when those dirs exist on
//      disk, so brew tools can still be visible to the *backend*. Full
//      isolation needs a clean VM / macOS user account.
//
// The shared global HF cache (~/.cache/huggingface — what the app resolves
// on macOS, see backend/core/config.py) is NEVER wiped by default: it holds
// models unrelated to OmniVoice. Set FRESH_NUKE_HF=1 to opt in.
//
// Usage:
//   bun desktop-fresh              # wipe traces + build + launch camouflaged
//   bun desktop-fresh:run          # same, but skip the build
//   bun desktop-fresh --dry-run    # print what WOULD be removed; change nothing
//   FRESH_NUKE_HF=1 bun desktop-fresh   # also wipe the global HF model cache
//
// This script is deliberately macOS-only (the trace paths and the launch
// mechanism are macOS-specific) and refuses to run elsewhere.
// ──────────────────────────────────────────────────────────────────────────
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  APP_ID,
  APP_NAME,
  hiddenFrom,
  isAppScoped,
  macosFreshTraces,
  sanitizedEnv,
  tauriBuildArgs,
} from "./desktop-common.mjs";

// ── macOS only ─────────────────────────────────────────────────────────────
if (process.platform !== "darwin") {
  console.error(
    [
      "",
      `❌ \`desktop-fresh\` is macOS-only (detected: ${process.platform}).`,
      "",
      "   The traces it wipes (~/Library/WebKit, ~/Library/HTTPStorages,",
      "   Preferences plists, Saved Application State) and its launch",
      "   mechanism (direct exec of the .app's Mach-O to propagate a",
      "   sanitized env) are macOS-specific.",
      "",
      "   On this platform use the regular fresh-install emulator instead:",
      "       bun desktop-prod",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// ── Flags ──────────────────────────────────────────────────────────────────
const HELP = `Usage: bun desktop-fresh [--skip-build] [--dry-run] [--pill]

  --skip-build   Skip the tauri build, launch the last compiled .app
  --dry-run      Print every path that WOULD be removed and what the
                 camouflaged launch would look like — change nothing
  --pill         Launch in dictation-widget mode (no main window)

Environment:
  FRESH_NUKE_HF=1   Also wipe the SHARED global Hugging Face cache
                    (~/.cache/huggingface). Off by default because it holds
                    models unrelated to OmniVoice.`;

let skipBuild = false;
let dryRun = false;
const launchArgs = [];
for (const arg of process.argv.slice(2)) {
  switch (arg) {
    case "--skip-build":
      skipBuild = true;
      break;
    case "--dry-run":
      dryRun = true;
      break;
    case "--pill":
      launchArgs.push("--pill");
      break;
    case "-h":
    case "--help":
      console.log(HELP);
      process.exit(0);
      break;
    default:
      console.error(`❌ Unknown flag: ${arg}\n\n${HELP}`);
      process.exit(1);
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const appBundle = join(
  repoRoot, "frontend", "src-tauri", "target", "debug", "bundle", "macos", `${APP_NAME}.app`,
);
const WOULD = dryRun ? " (dry-run)" : "";

/** Human dir/file size via `du -sh` (darwin-only script, du is always there). */
function sizeOf(p) {
  const res = spawnSync("du", ["-sh", p], { encoding: "utf8" });
  const size = res.status === 0 ? res.stdout.split("\t")[0].trim() : "";
  return size ? ` (${size})` : "";
}

// ── Kill-before-wipe: never clean under a live instance ────────────────────
// Wiping data under a running app leaves a ZOMBIE backend: its code is in
// memory, /health keeps answering, and the next launch happily attaches to
// it — then every real route 500s off deleted site-packages and an empty DB
// (observed 2026-07-11). Terminate app + backend first; --dry-run only reports.
{
  const patterns = [`${APP_NAME}.app`, "target/debug/omnivoice-studio"];
  /** PIDs of our own processes: bundle/dev-binary matches + any 3900 listener
   *  whose command is app-scoped (never a foreign process on the port). */
  const findPids = () => {
    const pids = new Set();
    for (const pat of patterns) {
      const pg = spawnSync("pgrep", ["-f", pat], { encoding: "utf8" });
      if (pg.status === 0)
        for (const pid of pg.stdout.trim().split("\n")) if (pid) pids.add(pid);
    }
    const lsof = spawnSync("lsof", ["-nP", "-iTCP:3900", "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
    });
    if (lsof.status === 0) {
      for (const pid of lsof.stdout.trim().split("\n")) {
        if (!pid) continue;
        const cmd = spawnSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).stdout;
        if (/omnivoice|com\.debpalash/i.test(cmd)) pids.add(pid);
      }
    }
    return [...pids];
  };
  const pids = findPids();
  if (pids.length > 0) {
    if (dryRun) {
      console.log(`🔪 Would terminate running ${APP_NAME} processes: ${pids.join(", ")}\n`);
    } else {
      console.log(`🔪 Terminating running ${APP_NAME} processes (${pids.join(", ")})...`);
      for (const pid of pids) spawnSync("kill", [pid]);
      // Grace period, then force anything still alive.
      const deadline = Date.now() + 5000;
      let alive = pids;
      while (alive.length > 0 && Date.now() < deadline) {
        spawnSync("sleep", ["0.5"]);
        alive = alive.filter((pid) => spawnSync("kill", ["-0", pid]).status === 0);
      }
      for (const pid of alive) spawnSync("kill", ["-9", pid]);
      console.log("   All stopped — safe to wipe.\n");
    }
  }
}

// ── 1. Blank slate: remove every install trace ─────────────────────────────
console.log(`🧹 Wiping every OmniVoice trace for new-user emulation${WOULD}...\n`);

/** Expand a trace entry into concrete existing paths. */
function expandTrace(trace) {
  if (trace.kind === "prefix") {
    const parent = dirname(trace.path);
    const prefix = basename(trace.path);
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(parent, name));
  }
  return existsSync(trace.path) ? [trace.path] : [];
}

for (const trace of macosFreshTraces(home)) {
  const targets = expandTrace(trace);
  if (targets.length === 0) {
    console.log(`   ○ absent        ${trace.label}: ${trace.path}${trace.kind === "prefix" ? "*" : ""}`);
    continue;
  }
  for (const target of targets) {
    const size = sizeOf(target);
    if (dryRun) {
      console.log(`   ▷ would remove  ${trace.label}: ${target}${size}`);
    } else {
      rmSync(target, { recursive: true, force: true });
      console.log(`   ✓ removed       ${trace.label}: ${target}${size}`);
    }
  }
}

// Preferences live in cfprefsd's cache beyond the plist file — flush them.
if (dryRun) {
  console.log(`   ▷ would run     defaults delete ${APP_ID} (flush cfprefsd cache)`);
} else {
  const res = spawnSync("defaults", ["delete", APP_ID], { stdio: "ignore" });
  console.log(
    res.status === 0
      ? `   ✓ flushed       cfprefsd preferences (defaults delete ${APP_ID})`
      : `   ○ absent        cfprefsd preferences (no cached domain)`,
  );
}

// ── 1b. HF model cache — shared, so opt-in only ────────────────────────────
// On macOS the app resolves the DEFAULT global cache (~/.cache/huggingface):
// backend/core/config.py only relocates the cache on Windows, and the
// camouflaged launch below hides HF_HOME/HF_HUB_CACHE from the app anyway.
const hfCache = join(home, ".cache", "huggingface");
console.log("");
if (!existsSync(hfCache)) {
  console.log(`   ○ absent        HF model cache: ${hfCache}`);
} else if (process.env.FRESH_NUKE_HF === "1") {
  const size = sizeOf(hfCache);
  if (dryRun) {
    console.log(`   ▷ would remove  HF model cache: ${hfCache}${size} — FRESH_NUKE_HF=1`);
  } else {
    rmSync(hfCache, { recursive: true, force: true });
    console.log(`   ✓ removed       HF model cache: ${hfCache}${size} — FRESH_NUKE_HF=1`);
  }
  console.log("     ↳ that was the machine-wide Hugging Face cache: ALL HF models are gone.");
} else {
  console.log(`   ◆ kept          HF model cache: ${hfCache}${sizeOf(hfCache)} — SHARED global cache`);
  console.log("     ↳ Not OmniVoice-scoped; wiping it would delete models unrelated to this app.");
  console.log("       Models will be REUSED (not re-downloaded). For a true cold first run:");
  console.log("       FRESH_NUKE_HF=1 bun desktop-fresh");
}
if (process.env.HF_HOME && !isAppScoped(process.env.HF_HOME)) {
  console.log(`     ↳ Note: your shell's HF_HOME (${process.env.HF_HOME}) is hidden from the app,`);
  console.log("       so the launched app uses the default cache path above.");
}

// ── 2. Build (debug bundle, updater artifacts off → exits 0) ───────────────
if (dryRun) {
  console.log(
    `\n▷ would ${skipBuild ? "skip the build (--skip-build)" : `build: bun run --cwd frontend ${tauriBuildArgs("darwin").join(" ")}`}`,
  );
} else if (skipBuild) {
  console.log("\n⏭️  Skipping build (--skip-build)");
} else {
  console.log("\n🔨 Building debug bundle (updater artifacts disabled)...");
  // Remove the stale bundle so we never accidentally launch old code.
  rmSync(appBundle, { recursive: true, force: true });
  // #962: invoke the Tauri CLI via the frontend workspace's `tauri` script,
  // not `bunx tauri` (bunx can fetch the unrelated npm `tauri` v1 package).
  const res = spawnSync("bun", ["run", "--cwd", "frontend", ...tauriBuildArgs("darwin")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(`\n❌ Build failed (exit ${res.status ?? `signal ${res.signal}`}).`);
    process.exit(res.status ?? 1);
  }
  console.log("✅ Build complete.");
}

// ── 3. Camouflage banner + launch ──────────────────────────────────────────
const env = sanitizedEnv(process.env);
const hidden = hiddenFrom(process.env);

console.log("\n🥸 Dev-machine camouflage — the app will NOT see:");
console.log(
  `   PATH entries: ${hidden.pathEntries.length > 0 ? hidden.pathEntries.join(", ") : "(none were on your PATH)"}`,
);
console.log(
  `   Env vars:     ${hidden.vars.length > 0 ? hidden.vars.join(", ") : "(none were set)"}`,
);
console.log("   ⚠ Limitation: the backend re-prepends /opt/homebrew/bin + /usr/local/bin to");
console.log("     its own PATH when those dirs exist (backend/core/config.py), so brew");
console.log("     ffmpeg/yt-dlp may still be visible to the backend. Full isolation needs a");
console.log("     clean VM or a separate macOS user account.");

const innerBinary = join(appBundle, "Contents", "MacOS", "omnivoice-studio");
if (dryRun) {
  console.log(`\n▷ would launch (direct exec, sanitized env): ${innerBinary}`);
  if (launchArgs.length > 0) console.log(`  with args: ${launchArgs.join(" ")}`);
  console.log("\n✅ Dry run complete — nothing was removed, built, or launched.");
  process.exit(0);
}

if (!existsSync(innerBinary)) {
  console.error(`\n❌ No app bundle at ${appBundle}.\n   Run without --skip-build first.`);
  process.exit(1);
}

console.log(`\n🚀 Launching ${APP_NAME} as a brand-new user...`);
console.log(`   Binary: ${innerBinary}`);
// Direct exec (NOT `open`) so the sanitized env actually reaches the app —
// see the header comment. detached+unref lets this script exit while the
// app keeps running, like `open` would.
const child = spawn(innerBinary, launchArgs, { env, detached: true, stdio: "ignore" });
child.unref();

console.log("\n✅ App launched in new-user mode. Check the splash for a full bootstrap.");
console.log("   To re-launch without rebuilding: bun desktop-fresh:run");
