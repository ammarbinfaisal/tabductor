export const ACTION_SUMMARY_LABELS = [
  "navigation", "screenshot", "interaction", "extract", "wait", "agent_update", "workflow_event", "tool",
] as const;
export type ActionSummaryLabel = typeof ACTION_SUMMARY_LABELS[number];
export const ACTION_SUMMARY_SOURCE_VERSION = "redacted-python-v1";
export const ACTION_SUMMARY_MAX_CODE = 8000;

// Keep public API vocabulary, not arbitrary variable names, selectors, URLs or values.
// This is a privacy filter, not a Python parser or an execution classifier.
const PUBLIC_WORDS = new Set(("await async def return if else elif for in while try except finally with as import from True False None and or not " +
  "page browser context workflow locator get_by_role get_by_text get_by_label get_by_placeholder get_by_test_id " +
  "goto screenshot click dblclick fill type press hover scroll scroll_into_view_if_needed select_option check uncheck " +
  "wait_for wait_for_timeout wait_for_load_state wait_for_url wait_for_selector sleep " +
  "inner_text text_content all_text_contents get_attribute count query_selector query_selector_all evaluate " +
  "first last nth all is_visible is_enabled content title url new_page close reload go_back go_forward " +
  "keyboard mouse frames pages evaluate_handle evaluate_all expect_popup expect_response expect_download " +
  "store define_table query insert upsert memory get set history output read record outcome " +
  "describe secrets captcha providers solve wait ai deopt yield_control emit batch done fail print len range").split(" "));

/** Lossy, bounded representation for the summary queue and provider egress only. */
export function sanitizeActionSummaryCode(code: string): string {
  const bounded = code.slice(0, ACTION_SUMMARY_MAX_CODE);
  // Consume unterminated literals through the end as well: traces can be truncated.
  const stripped = bounded.replace(/#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[^\\])*(?:"""|$)|'''(?:\\[\s\S]|(?!''')[^\\])*(?:'''|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/g,
    token => token.startsWith("#") ? " " : '"[REDACTED]"');
  return stripped.replace(/[\p{L}\p{N}_]+/gu, word => PUBLIC_WORDS.has(word) ? word : "redacted")
    .replace(/[^a-zA-Z_\s.(),:;=+\-*/<>!\[\]{}"']/g, " ").slice(0, ACTION_SUMMARY_MAX_CODE);
}

/** Intent only: neither the label nor description implies a runtime outcome. */
export function fallbackActionSummary(tool: unknown): { label: ActionSummaryLabel; summary: string } {
  if (tool === "browser.screenshot") return { label: "screenshot", summary: "Request a browser screenshot" };
  if (tool === "page.goto") return { label: "navigation", summary: "Navigate to a page" };
  if (tool === "browser.python") return { label: "tool", summary: "Run browser Python code" };
  return { label: "tool", summary: "Run a browser tool" };
}
