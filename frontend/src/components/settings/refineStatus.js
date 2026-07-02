/**
 * Honesty layer for the dictation-refinement `llm_ready` flag.
 *
 * `llm_ready` only means "an endpoint is CONFIGURED" — a placeholder key or a
 * dead local endpoint still reads ready. The backend also reports
 * `last_refine_status` ({ok, reason, at}) from the most recent final, so the
 * panel can tell the user when a configured LLM is actually failing/timing out.
 * The dictation final is never blocked (the hard refine timeout inserts the raw
 * text regardless), so this message is purely informational.
 *
 * Returns the user-facing string, or null when the last refinement succeeded /
 * hasn't run.
 */
export function refineFailureNote(status) {
  if (!status || status.ok !== false) return null;
  return status.reason === 'timeout'
    ? 'The last dictation refinement timed out — the LLM endpoint is slow or unreachable. Dictation still works (the raw transcript is inserted). Test the connection in LLM Providers.'
    : 'The last dictation refinement failed — the configured LLM endpoint rejected the request. Dictation still works (the raw transcript is inserted). Test the connection in LLM Providers.';
}
