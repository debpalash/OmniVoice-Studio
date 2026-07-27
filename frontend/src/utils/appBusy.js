/**
 * "Is long-running work in flight?" — the single answer, for anything that
 * would destroy that work.
 *
 * Today the only caller that matters is the updater: installing an update
 * relaunches the process, so anything mid-flight is lost. That check used to
 * be written inline as `dubStep === 'generating'`, which covered exactly one
 * of the app's long operations and silently permitted a relaunch during a dub
 * upload, a transcription, a translation, a standalone TTS synth, or an
 * export. It was also duplicated in two places, so the two could drift.
 *
 * The signals unioned here are the ones the store actually knows about:
 *
 *   - `dubStep`      — the dub workflow's own state machine
 *   - `stage`        — the floating status pill, which every long background
 *                      operation already pushes to (ASR model load, dictation
 *                      capture, transcribe, translate, export, refine)
 *   - `ttsGenerating` — standalone synth, mirrored out of useTTS's local state
 *                      precisely so a global check like this one can see it
 *
 * Deliberately NOT busy:
 *
 *   - `dubStep === 'editing'` — the transcript is open and waiting on the
 *     user, which is not an operation. Counting it would block updates for as
 *     long as a tab stays open, which is its own bug.
 *   - `'done'` / `'error'` — terminal; the work already survived or didn't.
 */

/** Dub steps where work is actually running (see `DubStep` in dubSlice). */
const BUSY_DUB_STEPS = new Set(['uploading', 'transcribing', 'generating', 'stopping']);

/** Pill stages that represent an operation in progress (see `PillStage`). */
const BUSY_PILL_STAGES = new Set([
  'loading-model',
  'recording',
  'transcribing',
  'translating',
  'generating',
  'exporting',
  'refining',
]);

/**
 * True when interrupting the app right now would lose work the user cares
 * about. Takes a store snapshot (`useAppStore.getState()`) rather than reading
 * the store itself, so it stays usable from event handlers and from tests.
 */
export function isAppBusy(state) {
  if (!state) return false;
  return (
    BUSY_DUB_STEPS.has(state.dubStep) ||
    BUSY_PILL_STAGES.has(state.stage) ||
    state.ttsGenerating === true
  );
}

export default isAppBusy;
