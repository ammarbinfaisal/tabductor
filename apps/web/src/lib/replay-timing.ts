export type ReplaySegment = { startMs: number; endMs: number; status: string };
/** HLS concatenates ready segments and omits gaps/private footage. Never seek across a gap. */
export function recordingToMedia(segments: ReplaySegment[], offsetMs: number): number | null {
  let mediaMs = 0;
  for (const segment of segments) {
    if (segment.status !== "ready") continue;
    if (offsetMs >= segment.startMs && offsetMs < segment.endMs) return (mediaMs + offsetMs - segment.startMs) / 1000;
    mediaMs += segment.endMs - segment.startMs;
  }
  return null;
}
export function mediaToRecording(segments: ReplaySegment[], seconds: number): number | null {
  let remaining = seconds * 1000;
  for (const segment of segments) {
    if (segment.status !== "ready") continue;
    const duration = segment.endMs - segment.startMs;
    if (remaining < duration) return segment.startMs + Math.max(0, remaining);
    remaining -= duration;
  }
  return null;
}
export const EVENT_LABELS: Record<string, { title: string; color: string }> = {
  navigation: { title: "Navigation", color: "blue" }, screenshot: { title: "Screenshot", color: "purple" },
  interaction: { title: "Action", color: "amber" }, extract: { title: "Extract", color: "teal" },
  wait: { title: "Wait", color: "slate" }, agent_update: { title: "Agent", color: "sky" },
  workflow_event: { title: "Event", color: "indigo" }, tool: { title: "Tool", color: "gray" },
};
