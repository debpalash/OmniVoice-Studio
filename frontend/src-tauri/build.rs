use std::path::PathBuf;

// Create a placeholder `binaries/<name>-<target-triple>` file if one doesn't
// already exist for the current target. Tauri's `bundle.externalBin`
// config is validated at every build (including `cargo check`), and it
// hard-errors when the source binary is missing — which it is in dev,
// because the real binaries are only fetched during release builds in CI.
// The placeholder is empty (zero bytes) and cannot actually be run;
// `find_bundled_*()` at runtime falls back to PATH or pip-bundled binaries
// when the bundled file isn't a real executable. CI overwrites these files
// with the real binaries before the tauri-action bundle step.
fn ensure_sidecar_placeholder(name: &str) {
    let triple = std::env::var("TARGET").unwrap_or_default();
    if triple.is_empty() {
        return;
    }
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let binaries_dir = PathBuf::from(&manifest_dir).join("binaries");
    let _ = std::fs::create_dir_all(&binaries_dir);
    let suffix = if triple.contains("windows") { ".exe" } else { "" };
    let target_path = binaries_dir.join(format!("{}-{}{}", name, triple, suffix));
    if !target_path.exists() {
        let _ = std::fs::write(&target_path, b"");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&target_path, perms);
            }
        }
    }
}

fn main() {
    // backend.rs bakes the analytics destination in with option_env!, which cargo
    // resolves at COMPILE time — so without these, a cached build would keep the
    // token it was first compiled with (in practice: none), and the secret would
    // appear to be ignored. Tell cargo the build depends on them.
    println!("cargo:rerun-if-env-changed=VITE_POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=VITE_POSTHOG_HOST");

    ensure_sidecar_placeholder("uv");
    ensure_sidecar_placeholder("ffmpeg");
    ensure_sidecar_placeholder("ffprobe");

    // Windows test binaries need the Common-Controls v6 manifest that
    // tauri-build embeds into the app binary but cargo gives tests none of:
    // without it the loader resolves comctl32 v5 (no TaskDialogIndirect —
    // imported by tauri's dialog/tray stack) and every integration-test
    // binary dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
    // See tests/windows-test.manifest.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into()))
            .join("tests")
            .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::build();
}
