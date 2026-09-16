import type { WorkflowChatEvent, WorkflowChatInput } from "@tabductor/engine";

/** Incremental NDJSON decoder: transport boundaries need not coincide with messages or UTF-8 characters. */
export async function sendWorkflowMessage(input: WorkflowChatInput, onEvent: (event: WorkflowChatEvent) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch("/api/workflow-chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "The assistant could not receive your message.");
  }
  if (!response.body) throw new Error("The assistant returned an empty response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const consume = (line: string): void => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as WorkflowChatEvent;
    if (event.type === "done") done = true;
    onEvent(event);
  };
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
      if (chunk.done) break;
    }
    consume(buffer);
    if (!done) throw new Error("The connection ended before the assistant finished. Completed changes are retained.");
  } finally { reader.releaseLock(); }
}
