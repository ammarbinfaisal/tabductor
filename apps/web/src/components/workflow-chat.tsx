"use client";

import type { ReactNode } from "react";
import type { EditorState, EditorStore } from "./editor-store.js";

export function WorkflowChat({ store, state }: { store: EditorStore; state: EditorState }) {
  const publishing = state.chatMessages.at(-1)?.tools?.some((tool) => tool.label === "Publishing draft" && tool.status === "running");
  const examples = state.graph.tasks.length ? ["Explain what this automation does", "Update the automation prompt", "Publish this draft"] : ["Collect 100 tweets from my For You timeline into Notion", "Check a product’s availability every morning", "Help me write an automation prompt"];
  return <section className="workflow-chat" aria-label="Workflow assistant">
    <header className="workflow-chat__header"><span className="chat-avatar" aria-hidden>✦</span><div><h2>Build with chat</h2><p>Describe the outcome. I’ll prepare the automation.</p></div></header>
    <div className="graph-chat-log" role="log" aria-label="Workflow conversation" aria-live="polite" aria-relevant="additions" onScroll={(event) => { const log = event.currentTarget; log.dataset.follow = String(log.scrollHeight - log.scrollTop - log.clientHeight < 120); }}>
      {state.chatMessages.length === 0 ? <div className="chat-welcome"><h3>What should your browser do?</h3><p>Tell me which sites to use, the result you want, and when it should happen. I’ll turn that into a prompt and a working draft. Sign in to sites through your browser profile.</p><div className="chat-suggestions">{examples.map((text) => <button key={text} className="btn--quiet" onClick={() => store.setAuthoringIntent(text)}>{text} <span aria-hidden>↗</span></button>)}</div></div> : null}
      {state.chatMessages.map((message, index) => <article key={index} className={`graph-chat-message graph-chat-message--${message.role}`} aria-label={message.role === "user" ? "You" : "Assistant"}>
        <span className="chat-message-author">{message.role === "user" ? "You" : "✦ Assistant"}</span>
        {message.tools?.length ? <div className="chat-tool-list">{message.tools.map((tool) => <div key={tool.id} className="chat-tool" data-status={tool.status}><span aria-hidden>{tool.status === "running" ? "◌" : tool.status === "complete" ? "✓" : "!"}</span> {tool.label}<span className="muted">{tool.status === "running" ? "Working…" : tool.status === "complete" ? "Done" : "Couldn’t finish"}</span></div>)}</div> : null}
        <ChatText text={message.text} />
        {state.chatPending && index === state.chatMessages.length - 1 && !message.text.trim() && !message.tools?.length ? <p className="chat-thinking" role="status">Thinking<span aria-hidden>…</span></p> : null}
      </article>)}
      <div className="chat-scroll-anchor" ref={(element) => { if (element) { const log = element.parentElement; if (log && log.dataset.follow !== "false") log.scrollTop = log.scrollHeight; } }} />
    </div>
    <form className="graph-chat-form" onSubmit={(event) => { event.preventDefault(); void store.sendMessage(); }}>
      <textarea id="graph-chat-message" aria-label="Message to workflow assistant" placeholder="Describe an automation or refine the prompt…" value={state.authoringIntent} maxLength={12000}
        onChange={(event) => store.setAuthoringIntent(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void store.sendMessage(); } }} />
      <div className="chat-composer-footer"><span>{state.dirty ? "Unpublished draft" : state.versionId ? "All changes published" : "Start with an idea"}</span>
        {state.chatPending ? <button className="btn--quiet" type="button" disabled={publishing} onClick={() => store.stopMessage()} aria-label="Stop response">{publishing ? "Publishing…" : "Stop ■"}</button>
          : <button className="btn--primary" type="submit" disabled={state.busy || !state.authoringIntent.trim()} aria-label="Send message">Send ↑</button>}
      </div>
    </form>
  </section>;
}

/** Small, escaped Markdown subset; model content is never injected as HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}
function ChatText({ text }: { text: string }) {
  return <div className="chat-text">{text.trim().split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => {
    const lines = paragraph.split("\n");
    if (lines.every((line) => /^[-*] /.test(line))) return <ul key={index}>{lines.map((line, i) => <li key={i}>{inline(line.slice(2))}</li>)}</ul>;
    if (lines.every((line) => /^\d+\. /.test(line))) return <ol key={index}>{lines.map((line, i) => <li key={i}>{inline(line.replace(/^\d+\. /, ""))}</li>)}</ol>;
    return <p key={index}>{inline(paragraph.replace(/^#{1,6} /, ""))}</p>;
  })}</div>;
}
