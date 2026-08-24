# Dictation

VoiceStudio dictation records from the system-wide shortcut, transcribes
locally, and—where the desktop permits it—inserts the result into the app where
the shortcut was pressed. The pill never needs keyboard focus.

The same flow is available to other applications through the bundled Rust
control sidecar. Herdr actions, editor extensions, agent hooks, and scripts can
start or stop VoiceStudio's capture over loopback HTTP/JSON-RPC or stream their
own microphone audio to the versioned WebSocket API. See the
[local speech platform](../speech-platform.md) for the protocol and examples.

## Use it

1. Choose an installed dictation model in the Model Catalogue.
2. Set the shortcut and hold/toggle behavior in **Settings → Hotkey**.
3. Put the cursor in a text field, press the shortcut, speak, then release or
   press again.

Whisper Tiny is the recommended default on macOS, Windows, and Linux. It
auto-detects more than 90 languages. Parakeet TDT v3 remains available for its
25 supported European languages, but it is not selected automatically.

The pill reports **Inserted** only after native delivery succeeds. **Copied**
means automatic insertion was unavailable and the complete final transcript is
ready for a normal paste. VoiceStudio retries a speech-level empty Sherpa decode
only through another ASR model whose weights are already installed; when that
fallback confirms the audio contains words, the silent model is demoted. This
recovery never starts a download.

## Destination and clipboard safety

The desktop captures the target at shortcut-down and carries its session ID
through partial, utterance, and summary messages. A late result from an older
session cannot use a newer session's target. macOS, Windows, and X11 validate
and reactivate the captured process/window before insertion. Wayland does not
expose a portable target identity or arbitrary foreign-window activation, so
the safe default leaves the transcript copied instead of guessing which app
should receive it. The GTK pill remains non-focusable.

For paste delivery, VoiceStudio snapshots text, HTML (with its plain-text
alternative), image, or file-list clipboard content, stages the transcript,
and restores the snapshot after the target consumes it.
Streaming segments share a generation-tracked lease: a stale restore cannot
win over a newer segment, and VoiceStudio never overwrites clipboard content
you copied during transcription. Unsupported clipboard formats cannot be
round-tripped; in that case the transcript remains on the clipboard instead of
attempting a lossy restore.

## Platform behavior

| Platform | Automatic insertion |
| --- | --- |
| macOS | Reactivates the captured application and sends Command-V. Without Accessibility permission, the result stays copied. |
| Windows | Validates the captured window and process, requests foreground activation, then sends Ctrl-V. If Windows denies activation, the result stays copied. |
| Linux X11 | Reactivates the captured X11 window through EWMH, verifies it, then sends Ctrl-V. |
| Wayland | Leaves the complete transcript copied because a portable captured-window identity is unavailable. |
| Browser mode | Copies the transcript; browsers cannot target another desktop app. |

Advanced Wayland users can set `VOICESTUDIO_WAYLAND_UNTARGETED_INSERT=1` to
insert into whichever client owns keyboard focus when transcription finishes.
wlroots compositors use `wtype`; KDE Plasma and GNOME can use clipboard paste
through `dotool` or `ydotool`. Helpers run with host loader variables from an
AppImage, have a bounded timeout, and never retry after one may have emitted
partial input. This opt-in cannot promise the shortcut-down target if focus
changes. `dotool` needs direct write access to `/dev/uinput`; `ydotool` 1.0+
needs a running `ydotoold` with that access and a user-readable socket.
VoiceStudio checks these prerequisites before selection. Tray-started Wayland
dictation always stays copy-only.
