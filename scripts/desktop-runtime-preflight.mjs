#!/usr/bin/env node
// Linux WebKitGTK aborts its renderer when an <audio> element is created
// without autoaudiosink. Enigo's default Linux backend also links libxdo.
// Catch both before starting the backend or opening a window (#1680, #1682).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** Read Linux distro metadata without making it a prerequisite elsewhere. */
function systemOsRelease() {
  try {
    return readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}

/** Return the package-manager command for the detected Linux family. */
export function linuxDesktopDependencyCommand(osRelease) {
  const ids = new Set();
  for (const line of osRelease.split(/\r?\n/)) {
    const match = /^(ID|ID_LIKE)=(.*)$/.exec(line);
    if (!match) continue;
    for (const id of match[2].replace(/^['"]|['"]$/g, "").toLowerCase().split(/\s+/)) {
      if (id) ids.add(id);
    }
  }
  if (["arch", "cachyos", "endeavouros", "manjaro"].some((id) => ids.has(id))) {
    return "sudo pacman -S --needed xdotool gst-plugins-good";
  }
  if (["debian", "ubuntu", "linuxmint", "pop"].some((id) => ids.has(id))) {
    return "sudo apt-get install libxdo-dev gstreamer1.0-plugins-good";
  }
  if (["fedora", "rhel", "centos"].some((id) => ids.has(id))) {
    return "sudo dnf install libxdo-devel gstreamer1-plugins-good";
  }
  return "install libxdo development files and the GStreamer 'good' plugins with your package manager";
}

/** Diagnose missing Linux-only linker/runtime pieces; return null when ready. */
export function desktopRuntimeProblem({
  platform = process.platform,
  run = spawnSync,
  osRelease = systemOsRelease(),
} = {}) {
  if (platform !== "linux") return null;

  const missing = [];
  const xdo = run("cc", ["-print-file-name=libxdo.so"], { encoding: "utf8" });
  if (xdo.status !== 0 || !xdo.stdout?.trim() || xdo.stdout.trim() === "libxdo.so") {
    missing.push("libxdo (required by Enigo at link time)");
  }

  const audioSink = run("gst-inspect-1.0", ["autoaudiosink"], { stdio: "ignore" });
  if (audioSink.status !== 0) {
    missing.push("GStreamer autoaudiosink (required by WebKit audio)");
  }
  if (missing.length === 0) return null;

  return [
    "",
    `❌ Linux desktop prerequisite${missing.length === 1 ? " is" : "s are"} missing:`,
    ...missing.map((item) => `   • ${item}`),
    "",
    "   Without autoaudiosink, WebKitGTK can abort its renderer when the UI",
    "   creates an audio element, leaving a blank window.",
    "",
    "   Install the required packages:",
    `     ${linuxDesktopDependencyCommand(osRelease)}`,
    "",
    "   Then rerun: bun desktop",
    "",
  ].join("\n");
}

/** Print an actionable diagnosis and report whether desktop launch may continue. */
export function desktopRuntimeReady(options) {
  const problem = desktopRuntimeProblem(options);
  if (!problem) return true;
  console.error(problem);
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(desktopRuntimeReady() ? 0 : 1);
}
