//! Temporary bisect probe for the Windows STATUS_ENTRYPOINT_NOT_FOUND load
//! failure of the backend_lifecycle harness binary: this integration test
//! links app_lib + tauri(test) exactly like the harness but runs nothing.
//! If THIS binary also fails to load on Windows, the problem is pure
//! linking; if it loads, the fault is in what the harness executes.

#[allow(unused_imports)]
use app_lib::bootstrap::BootstrapStage;

#[test]
fn probe_binary_loads() {
    // Touch a tauri::test symbol so the linker keeps the same imports.
    let _b = tauri::test::mock_builder();
    assert!(matches!(BootstrapStage::Checking, BootstrapStage::Checking));
}
