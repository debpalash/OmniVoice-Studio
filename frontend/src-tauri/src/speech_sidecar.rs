//! Headless loopback control plane for VoiceStudio dictation.
//!
//! The Python backend owns ASR data-plane protocols. This small Rust server
//! owns desktop authority: start/stop capture and the session-bound native
//! insertion target. Native integrations can therefore control the bundled
//! dictation service without embedding a WebView or depending on Tauri IPC.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

use crate::dictation_output::CaptureOrigin;
use crate::{backend_port, dispatch_dictation_capture, AppFlags};

const DEFAULT_SIDECAR_PORT: u16 = 3902;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_REQUEST_BYTES: usize = MAX_BODY_BYTES + 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DictationAction {
    Start,
    Stop,
    Toggle,
}

impl DictationAction {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Toggle => "toggle",
        }
    }
}

pub struct SpeechSidecarState {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for SpeechSidecarState {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

struct HttpRequest {
    method: String,
    path: String,
    origin: Option<String>,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    body: Value,
}

impl HttpResponse {
    fn ok(body: Value) -> Self {
        Self { status: 200, body }
    }

    fn error(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            body: json!({"error": {"code": code, "message": message}}),
        }
    }
}

pub fn sidecar_port() -> u16 {
    std::env::var("VOICESTUDIO_SPEECH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_SIDECAR_PORT)
}

pub fn cli_dictation_action(args: &[String]) -> Option<DictationAction> {
    if args.iter().any(|arg| arg == "--dictate-start") {
        return Some(DictationAction::Start);
    }
    if args.iter().any(|arg| arg == "--dictate-stop") {
        return Some(DictationAction::Stop);
    }
    if args
        .iter()
        .any(|arg| arg == "--dictate" || arg == "--dictate-toggle")
    {
        return Some(DictationAction::Toggle);
    }
    None
}

fn plan_action(
    requested: DictationAction,
    is_recording: bool,
    has_session: bool,
) -> Option<DictationAction> {
    match requested {
        DictationAction::Start if !is_recording && !has_session => Some(DictationAction::Start),
        DictationAction::Stop if is_recording || has_session => Some(DictationAction::Stop),
        DictationAction::Toggle if is_recording || has_session => Some(DictationAction::Stop),
        DictationAction::Toggle => Some(DictationAction::Start),
        _ => None,
    }
}

pub fn dispatch_action(app: &tauri::AppHandle, action: DictationAction) -> Value {
    let flags = app.state::<AppFlags>();
    let before = flags.dictating.load(Ordering::SeqCst);
    // A start event creates its output session synchronously, before the
    // WebView can report `dictating=true`. Use both signals so two rapid
    // toggle calls mean start-then-stop instead of duplicate starts.
    let has_session = flags.output.current_session_id().is_some();
    let planned = plan_action(action, before, has_session);
    if let Some(planned) = planned {
        dispatch_dictation_capture(app, planned.wire_name());
    }
    let session_id = app.state::<AppFlags>().output.current_session_id();
    json!({
        "accepted": true,
        "action": action.wire_name(),
        "dispatched_action": planned.map(DictationAction::wire_name),
        "already_in_requested_state": planned.is_none(),
        "recording_before_request": before,
        "session_id": session_id,
    })
}

fn status(app: &tauri::AppHandle, port: u16) -> Value {
    let flags = app.state::<AppFlags>();
    let engine_port = backend_port();
    json!({
        "schema": "voicestudio.speech-control-status",
        "protocol": "voicestudio.speech.v1",
        "service": "VoiceStudio",
        "service_version": env!("CARGO_PKG_VERSION"),
        "recording": flags.dictating.load(Ordering::SeqCst),
        "session_id": flags.output.current_session_id(),
        "control_url": format!("http://127.0.0.1:{port}"),
        "engine_url": format!("http://127.0.0.1:{engine_port}"),
    })
}

fn capabilities(port: u16) -> Value {
    let engine_port = backend_port();
    json!({
        "schema": "voicestudio.speech-capabilities",
        "protocol": "voicestudio.speech.v1",
        "protocol_version": "1.0",
        "service": "VoiceStudio",
        "service_version": env!("CARGO_PKG_VERSION"),
        "local_first": true,
        "endpoints": {
            "status": format!("http://127.0.0.1:{port}/v1/status"),
            "dictation_start": format!("http://127.0.0.1:{port}/v1/dictation/start"),
            "dictation_stop": format!("http://127.0.0.1:{port}/v1/dictation/stop"),
            "dictation_toggle": format!("http://127.0.0.1:{port}/v1/dictation/toggle"),
            "output_sessions": format!("http://127.0.0.1:{port}/v1/output/sessions"),
            "json_rpc": format!("http://127.0.0.1:{port}/rpc"),
            "batch_transcription": format!("http://127.0.0.1:{engine_port}/v1/audio/transcriptions"),
            "streaming_transcription": format!("ws://127.0.0.1:{engine_port}/v1/audio/transcriptions/stream"),
            "mcp": format!("http://127.0.0.1:{engine_port}/mcp"),
        },
        "cli": {
            "start": "--dictate-start",
            "stop": "--dictate-stop",
            "toggle": "--dictate-toggle",
        },
    })
}

fn parse_output_session_path(path: &str) -> Option<(u64, bool)> {
    let suffix = path.strip_prefix("/v1/output/sessions/")?;
    if let Some(raw_id) = suffix.strip_suffix("/insert") {
        return raw_id.parse().ok().map(|id| (id, true));
    }
    suffix.parse().ok().map(|id| (id, false))
}

fn begin_output_session(app: &tauri::AppHandle) -> HttpResponse {
    let flags = app.state::<AppFlags>();
    if flags.output.current_session_id().is_some() {
        return HttpResponse::error(
            409,
            "output_busy",
            "another dictation output session is active",
        );
    }
    let session_id = flags.output.begin_session(CaptureOrigin::Shortcut);
    HttpResponse::ok(json!({"session_id": session_id}))
}

fn insert_output_session(app: &tauri::AppHandle, session_id: u64, body: &[u8]) -> HttpResponse {
    let request: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return HttpResponse::error(400, "invalid_json", "body must be JSON"),
    };
    let Some(text) = request.get("text").and_then(Value::as_str) else {
        return HttpResponse::error(400, "invalid_text", "body requires a string text field");
    };
    let output = app.state::<AppFlags>().output.clone();
    if output.current_session_id() != Some(session_id) {
        return HttpResponse::error(409, "stale_session", "output session is not active");
    }
    let result = output
        .activate_session(session_id)
        .and_then(|_| output.deliver(session_id, text));
    output.finish_session(session_id);
    match result {
        Ok(outcome) => HttpResponse::ok(json!({
            "session_id": session_id,
            "outcome": outcome,
        })),
        Err(error) => HttpResponse::error(500, "delivery_failed", &error),
    }
}

fn cancel_output_session(app: &tauri::AppHandle, session_id: u64) -> HttpResponse {
    let output = app.state::<AppFlags>().output.clone();
    if output.current_session_id() != Some(session_id) {
        return HttpResponse::error(409, "stale_session", "output session is not active");
    }
    output.finish_session(session_id);
    HttpResponse::ok(json!({"session_id": session_id, "cancelled": true}))
}

fn action_for_path(path: &str) -> Option<DictationAction> {
    match path {
        "/v1/dictation/start" => Some(DictationAction::Start),
        "/v1/dictation/stop" => Some(DictationAction::Stop),
        "/v1/dictation/toggle" => Some(DictationAction::Toggle),
        _ => None,
    }
}

fn action_for_rpc_method(method: &str) -> Option<DictationAction> {
    match method {
        "dictation.start" => Some(DictationAction::Start),
        "dictation.stop" => Some(DictationAction::Stop),
        "dictation.toggle" => Some(DictationAction::Toggle),
        _ => None,
    }
}

fn handle_rpc(app: &tauri::AppHandle, body: &[u8]) -> HttpResponse {
    let request: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => {
            return HttpResponse::ok(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {"code": -32700, "message": "Parse error"},
            }));
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return HttpResponse::ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32600, "message": "Invalid Request"},
        }));
    };
    let Some(action) = action_for_rpc_method(method) else {
        return HttpResponse::ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {"code": -32601, "message": "Method not found"},
        }));
    };
    HttpResponse::ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": dispatch_action(app, action),
    }))
}

fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:3901"
            | "http://127.0.0.1:3901"
    )
}

fn route(app: &tauri::AppHandle, request: HttpRequest, port: u16) -> HttpResponse {
    if !origin_allowed(request.origin.as_deref()) {
        return HttpResponse::error(
            403,
            "origin_denied",
            "browser origins cannot control dictation",
        );
    }
    let path = request.path.split('?').next().unwrap_or(&request.path);
    match (request.method.as_str(), path) {
        ("GET", "/health") | ("GET", "/v1/status") => HttpResponse::ok(status(app, port)),
        ("GET", "/.well-known/voicestudio-speech") | ("GET", "/v1/capabilities") => {
            HttpResponse::ok(capabilities(port))
        }
        ("POST", "/v1/output/sessions") => begin_output_session(app),
        ("POST", "/rpc") => handle_rpc(app, &request.body),
        ("POST", path) if parse_output_session_path(path).is_some() => {
            let (session_id, is_insert) = parse_output_session_path(path).expect("guarded above");
            if !is_insert {
                return HttpResponse::error(405, "method_not_allowed", "use DELETE");
            }
            insert_output_session(app, session_id, &request.body)
        }
        ("DELETE", path) if parse_output_session_path(path).is_some() => {
            let (session_id, is_insert) = parse_output_session_path(path).expect("guarded above");
            if is_insert {
                return HttpResponse::error(405, "method_not_allowed", "use POST");
            }
            cancel_output_session(app, session_id)
        }
        ("POST", path) => match action_for_path(path) {
            Some(action) => HttpResponse::ok(dispatch_action(app, action)),
            None => HttpResponse::error(404, "not_found", "unknown speech-control endpoint"),
        },
        (_, "/v1/dictation/start" | "/v1/dictation/stop" | "/v1/dictation/toggle") => {
            HttpResponse::error(405, "method_not_allowed", "use POST")
        }
        _ => HttpResponse::error(404, "not_found", "unknown speech-control endpoint"),
    }
}

fn header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, &'static str> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "read timeout setup failed")?;
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 2048];
    let mut expected_len = None;
    loop {
        let read = stream.read(&mut chunk).map_err(|_| "request read failed")?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err("request too large");
        }
        if let Some(end) = header_end(&bytes) {
            if expected_len.is_none() {
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if content_length > MAX_BODY_BYTES {
                    return Err("request body too large");
                }
                expected_len = Some(end + 4 + content_length);
            }
            if bytes.len() >= expected_len.unwrap_or(end + 4) {
                break;
            }
        }
    }
    let end = header_end(&bytes).ok_or("incomplete request headers")?;
    let headers = String::from_utf8_lossy(&bytes[..end]);
    let mut lines = headers.lines();
    let mut request_line = lines
        .next()
        .ok_or("missing request line")?
        .split_whitespace();
    let method = request_line.next().ok_or("missing method")?.to_owned();
    let path = request_line.next().ok_or("missing path")?.to_owned();
    let origin = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("origin")
            .then(|| value.trim().to_owned())
    });
    Ok(HttpRequest {
        method,
        path,
        origin,
        body: bytes[end + 4..].to_vec(),
    })
}

fn write_response(stream: &mut TcpStream, response: HttpResponse) {
    let body = response.body.to_string();
    let reason = match response.status {
        200 => "OK",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Bad Request",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        response.status,
        reason,
        body.len(),
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn handle_connection(app: &tauri::AppHandle, mut stream: TcpStream, port: u16) {
    match read_request(&mut stream) {
        Ok(request) => write_response(&mut stream, route(app, request, port)),
        Err(message) => {
            let status = if message.contains("too large") {
                413
            } else {
                400
            };
            write_response(
                &mut stream,
                HttpResponse::error(status, "invalid_request", message),
            );
        }
    }
}

pub fn start(app: tauri::AppHandle) -> Result<SpeechSidecarState, String> {
    let port = sidecar_port();
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("could not bind 127.0.0.1:{port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("could not configure speech sidecar: {error}"))?;

    // The child Python backend inherits this and advertises the native control
    // endpoint only when the desktop shell actually owns it.
    std::env::set_var("VOICESTUDIO_SPEECH_CONTROL_PORT", port.to_string());

    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    thread::Builder::new()
        .name("speech-control-sidecar".into())
        .spawn(move || {
            log::info!("Speech control sidecar listening on 127.0.0.1:{port}");
            while !thread_stop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => handle_connection(&app, stream, port),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(30));
                    }
                    Err(error) => {
                        log::warn!("Speech control sidecar accept failed: {error}");
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        })
        .map_err(|error| format!("could not start speech sidecar thread: {error}"))?;

    Ok(SpeechSidecarState { port, stop })
}

#[cfg(test)]
mod tests {
    use super::{
        action_for_path, action_for_rpc_method, cli_dictation_action, origin_allowed,
        parse_output_session_path, plan_action, DictationAction,
    };

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn cli_flags_map_to_idempotent_actions() {
        assert_eq!(
            cli_dictation_action(&args(&["VoiceStudio", "--dictate-start"])),
            Some(DictationAction::Start)
        );
        assert_eq!(
            cli_dictation_action(&args(&["VoiceStudio", "--dictate-stop"])),
            Some(DictationAction::Stop)
        );
        assert_eq!(
            cli_dictation_action(&args(&["VoiceStudio", "--dictate-toggle"])),
            Some(DictationAction::Toggle)
        );
        assert_eq!(cli_dictation_action(&args(&["VoiceStudio"])), None);
    }

    #[test]
    fn http_and_json_rpc_share_the_same_action_vocabulary() {
        assert_eq!(
            action_for_path("/v1/dictation/start"),
            Some(DictationAction::Start)
        );
        assert_eq!(
            action_for_rpc_method("dictation.stop"),
            Some(DictationAction::Stop)
        );
        assert_eq!(action_for_rpc_method("dictation.delete"), None);
    }

    #[test]
    fn pending_start_makes_a_second_toggle_stop() {
        assert_eq!(
            plan_action(DictationAction::Toggle, false, false),
            Some(DictationAction::Start)
        );
        assert_eq!(
            plan_action(DictationAction::Toggle, false, true),
            Some(DictationAction::Stop)
        );
        assert_eq!(plan_action(DictationAction::Start, false, true), None);
    }

    #[test]
    fn browser_origins_cannot_silently_trigger_the_microphone() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://tauri.localhost")));
        assert!(origin_allowed(Some("http://localhost:3901")));
        assert!(!origin_allowed(Some("https://example.com")));
        assert!(!origin_allowed(Some("http://localhost.evil.test")));
    }

    #[test]
    fn output_session_paths_are_strictly_typed() {
        assert_eq!(
            parse_output_session_path("/v1/output/sessions/42"),
            Some((42, false))
        );
        assert_eq!(
            parse_output_session_path("/v1/output/sessions/42/insert"),
            Some((42, true))
        );
        assert_eq!(parse_output_session_path("/v1/output/sessions/nope"), None);
    }
}
