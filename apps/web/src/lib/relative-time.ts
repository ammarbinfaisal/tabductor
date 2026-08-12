/**
 * Hand-rolled relative time (U1.5) — no date library (ROADMAP style rule: no new deps),
 * and every other timestamp in this app already renders with `Date.prototype` methods, so
 * this stays in that family rather than reaching for `Intl.RelativeTimeFormat`'s pluralization
 * machinery for six units.
 */
const UNITS: ReadonlyArray<readonly [string, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(at: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - at.getTime()) / 1000);
  if (seconds < 45) return "just now";
  for (const [unit, secondsInUnit] of UNITS) {
    const value = Math.floor(seconds / secondsInUnit);
    if (value >= 1) return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
