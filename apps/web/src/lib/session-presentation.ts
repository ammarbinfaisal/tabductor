/** Browser lifetime, not the outcome of any individual step, controls the media surface. */
export function sessionPresentation(status: string | undefined, recordingStatus?: string, hasReadySegments = false) {
  const active = status === "ready" || status === "running";
  const stopped = status === "ended" || status === "failed";
  const replay = stopped && hasReadySegments && recordingStatus !== "expired" && recordingStatus !== "unavailable";
  return { active, stopped, replay };
}
