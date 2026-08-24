//! Orderly desktop exit/relaunch handshake for async browser persistence.
//!
//! `pagehide` cannot keep an IndexedDB transaction alive. For ordinary exits
//! we therefore prevent the first `ExitRequested`, ask the main webview to
//! flush, and exit only after its acknowledgement. A deadline prevents a dead
//! or not-yet-mounted webview from trapping the native process indefinitely.

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::AppFlags;

pub const PERSISTENCE_FLUSH_EVENT: &str = "persistence://flush-requested";
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
enum ExitAction {
    Exit,
    Restart,
    Spawn(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ExitPlan {
    code: i32,
    action: ExitAction,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExitRequestDecision {
    BeginFlush,
    WaitForFlush,
    Allow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitPhase {
    Idle,
    Waiting,
    Ready,
}

struct ExitStateInner {
    phase: ExitPhase,
    code: i32,
    action: ExitAction,
}

impl Default for ExitStateInner {
    fn default() -> Self {
        Self {
            phase: ExitPhase::Idle,
            code: 0,
            action: ExitAction::Exit,
        }
    }
}

#[derive(Default)]
pub struct PersistenceExitState {
    inner: Mutex<ExitStateInner>,
}

impl PersistenceExitState {
    fn request(&self, code: Option<i32>) -> ExitRequestDecision {
        let Ok(mut inner) = self.inner.lock() else {
            // A poisoned coordination lock must never make VoiceStudio
            // impossible to close.
            return ExitRequestDecision::Allow;
        };
        match inner.phase {
            ExitPhase::Idle => {
                inner.phase = ExitPhase::Waiting;
                inner.code = code.unwrap_or(0);
                ExitRequestDecision::BeginFlush
            }
            ExitPhase::Waiting => ExitRequestDecision::WaitForFlush,
            ExitPhase::Ready => ExitRequestDecision::Allow,
        }
    }

    fn queue_action(&self, action: ExitAction) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "persistence exit state lock poisoned".to_string())?;
        if inner.phase != ExitPhase::Idle {
            return Err("an application exit is already in progress".into());
        }
        inner.action = action;
        Ok(())
    }

    fn complete(&self) -> Option<ExitPlan> {
        let Ok(mut inner) = self.inner.lock() else {
            log::warn!("Persistence exit state lock poisoned");
            return None;
        };
        if inner.phase != ExitPhase::Waiting {
            return None;
        }
        inner.phase = ExitPhase::Ready;
        Some(ExitPlan {
            code: inner.code,
            action: inner.action.clone(),
        })
    }
}

fn perform_exit_plan(app: &tauri::AppHandle, plan: ExitPlan, source: &str) {
    log::info!("Persistence exit handshake completed via {source}");
    match plan.action {
        ExitAction::Exit => app.exit(plan.code),
        // `restart()` may bypass RunEvent delivery when invoked by a command
        // on the main thread. `request_restart()` reliably returns through the
        // ExitRequested callback so the tracked backend is shut down first.
        ExitAction::Restart => app.request_restart(),
        ExitAction::Spawn(args) => {
            match std::env::current_exe()
                .and_then(|executable| Command::new(executable).args(args).spawn())
            {
                Ok(_) => {}
                Err(error) => log::error!("Could not launch the requested app mode: {error}"),
            }
            app.exit(plan.code);
        }
    }
}

fn complete_pending_exit(app: &tauri::AppHandle, source: &str) -> bool {
    let Some(plan) = app.state::<PersistenceExitState>().complete() else {
        return false;
    };
    perform_exit_plan(app, plan, source);
    true
}

fn schedule_timeout(app: tauri::AppHandle) {
    // The frontend materializes its latest full localStorage fallback before
    // awaiting IndexedDB. A blocked transaction may outlive this deadline,
    // but the timeout cannot overtake the only recoverable project copy.
    std::thread::spawn(move || {
        std::thread::sleep(EXIT_FLUSH_TIMEOUT);
        if complete_pending_exit(&app, "native timeout") {
            log::warn!(
                "Persistence flush acknowledgement did not arrive within {} ms; exiting anyway",
                EXIT_FLUSH_TIMEOUT.as_millis()
            );
        }
    });
}

/// Return true only when this exit request may proceed to native teardown.
pub(crate) fn handle_exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) -> bool {
    // Tauri explicitly ignores prevent_exit() for its restart exit code. All
    // intentional frontend restarts flush before calling relaunch, while the
    // native cache-repair restart is queued through this module below.
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return true;
    }

    match app.state::<PersistenceExitState>().request(code) {
        ExitRequestDecision::Allow => true,
        ExitRequestDecision::WaitForFlush => {
            api.prevent_exit();
            false
        }
        ExitRequestDecision::BeginFlush => {
            api.prevent_exit();
            if let Err(error) = app.emit_to("main", PERSISTENCE_FLUSH_EVENT, ()) {
                log::warn!("Could not request a frontend persistence flush: {error}");
            }
            schedule_timeout(app.clone());
            false
        }
    }
}

fn request_action(app: &tauri::AppHandle, action: ExitAction) -> Result<(), String> {
    app.state::<PersistenceExitState>().queue_action(action)?;
    // Stop backend supervision while the bounded frontend flush is pending.
    app.state::<AppFlags>()
        .quitting
        .store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

pub fn request_restart(app: &tauri::AppHandle) -> Result<(), String> {
    request_action(app, ExitAction::Restart)
}

pub fn request_spawned_relaunch(app: &tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    request_action(app, ExitAction::Spawn(args))
}

#[tauri::command]
pub fn confirm_persistence_flush(app: tauri::AppHandle) -> bool {
    complete_pending_exit(&app, "frontend acknowledgement")
}

#[cfg(test)]
mod tests {
    use super::{
        ExitAction, ExitPhase, ExitRequestDecision, PersistenceExitState, EXIT_FLUSH_TIMEOUT,
    };

    #[test]
    fn first_exit_waits_for_flush_and_only_acknowledgement_allows_the_next() {
        let state = PersistenceExitState::default();

        assert_eq!(state.request(Some(17)), ExitRequestDecision::BeginFlush);
        assert_eq!(
            state.request(Some(99)),
            ExitRequestDecision::WaitForFlush,
            "a repeated quit must not replace the original exit code"
        );
        let plan = state.complete().expect("waiting exit should complete");
        assert_eq!(plan.code, 17);
        assert_eq!(plan.action, ExitAction::Exit);
        assert_eq!(state.request(None), ExitRequestDecision::Allow);
    }

    #[test]
    fn frontend_and_timeout_can_complete_the_same_exit_only_once() {
        let state = PersistenceExitState::default();
        assert_eq!(state.request(None), ExitRequestDecision::BeginFlush);

        assert!(state.complete().is_some());
        assert!(state.complete().is_none());
    }

    #[test]
    fn poisoned_lock_never_synthesizes_an_unrequested_exit() {
        let state = PersistenceExitState::default();
        let _ = std::panic::catch_unwind(|| {
            let _guard = state.inner.lock().unwrap();
            panic!("poison test lock");
        });

        assert!(state.complete().is_none());
    }

    #[test]
    fn restart_and_mode_switch_are_deferred_until_flush_completion() {
        let restart = PersistenceExitState::default();
        restart.queue_action(ExitAction::Restart).unwrap();
        assert_eq!(restart.request(None), ExitRequestDecision::BeginFlush);
        assert_eq!(restart.complete().unwrap().action, ExitAction::Restart);

        let mode_switch = PersistenceExitState::default();
        mode_switch
            .queue_action(ExitAction::Spawn(vec!["--pill".into()]))
            .unwrap();
        assert_eq!(mode_switch.request(None), ExitRequestDecision::BeginFlush);
        assert_eq!(
            mode_switch.complete().unwrap().action,
            ExitAction::Spawn(vec!["--pill".into()])
        );
    }

    #[test]
    fn actions_cannot_change_once_exit_has_started() {
        let state = PersistenceExitState::default();
        assert_eq!(state.request(None), ExitRequestDecision::BeginFlush);
        assert!(state.queue_action(ExitAction::Restart).is_err());
        assert_eq!(state.inner.lock().unwrap().phase, ExitPhase::Waiting);
    }

    #[test]
    fn native_fallback_is_short_and_bounded() {
        assert!(EXIT_FLUSH_TIMEOUT >= std::time::Duration::from_millis(500));
        assert!(EXIT_FLUSH_TIMEOUT <= std::time::Duration::from_secs(5));
    }
}
