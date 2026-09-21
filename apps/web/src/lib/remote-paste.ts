/** Capture explicit host paste gestures before noVNC consumes their key events. */
export function attachRemotePaste(target: HTMLElement, options: {
  enabled: () => boolean;
  paste: (text: string) => Promise<unknown>;
  report: (error: unknown) => void;
}) {
  let disposed = false;
  let pending = Promise.resolve();
  const enabled = () => !disposed && options.enabled();
  const onKey = (event: KeyboardEvent) => {
    if (!enabled() || event.altKey) return;
    if (((event.ctrlKey || event.metaKey) && event.code === "KeyV") ||
        (event.shiftKey && event.code === "Insert")) {
      // Keep the native default action: it supplies clipboardData even on HTTP.
      // noVNC would otherwise prevent that action and paste the old remote text.
      event.stopPropagation();
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!enabled() || !event.clipboardData) return;
    event.preventDefault();
    event.stopPropagation();
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    pending = pending.then(async () => {
      if (!enabled()) return;
      if (text.length > 100_000) throw new Error("Paste up to 100,000 characters at a time.");
      await options.paste(text);
    }).catch(error => { if (enabled()) options.report(error); });
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("keyup", onKey, true);
  target.addEventListener("paste", onPaste, true);
  return () => {
    disposed = true;
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("keyup", onKey, true);
    target.removeEventListener("paste", onPaste, true);
  };
}
