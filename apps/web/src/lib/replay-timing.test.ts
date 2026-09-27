import { expect, it } from "vitest";
import { mediaToRecording, recordingToMedia } from "./replay-timing.js";
const segments = [
  { startMs: 0, endMs: 150, status: "gap" },
  { startMs: 150, endMs: 2150, status: "ready" },
  { startMs: 2150, endMs: 5150, status: "private" },
  { startMs: 5150, endMs: 6650, status: "ready" },
];
it("maps concatenated media across unavailable intervals in both directions", () => {
  expect(recordingToMedia(segments, 6150)).toBe(3);
  expect(mediaToRecording(segments, 3)).toBe(6150);
  expect(recordingToMedia(segments, 2150)).toBeNull();
  expect(recordingToMedia(segments, 100)).toBeNull();
  expect(mediaToRecording(segments, 2)).toBe(5150);
  expect(recordingToMedia(segments, 6650)).toBeNull();
  expect(mediaToRecording(segments, 4)).toBeNull();
});
