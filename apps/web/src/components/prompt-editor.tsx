"use client";

import Link from "next/link";
import { createStore } from "zustand/vanilla";
import { promptInputNames } from "@tabductor/core/prompt-inputs";
import { api, asApiError, type RouterOutputs } from "../lib/api.js";
import { usePolling, useStoreBridge } from "../lib/store.js";
import { parseResultSchemaText } from "../lib/result-schema.js";
import { randomUUID } from "../lib/uuid.js";
import { WorkflowName } from "./workflow-name.js";
import { Stamp } from "./primitives.js";

type Props = RouterOutputs["workflow"]["get"];
function makeStore(props: Props) {
  return createStore(() => ({ id: props.workflow.id, versionId: props.versionId, prompt: props.definition?.prompt ?? "", savedPrompt: props.definition?.prompt ?? "",
    schema: props.definition?.resultSchema == null ? "" : JSON.stringify(props.definition.resultSchema, null, 2),
    definition: props.definition, inputs: {} as Record<string, string>, busy: false, error: null as string | null,
    progress: null as RouterOutputs["workflow"]["progress"] | null }));
}
let current: ReturnType<typeof makeStore> | undefined;
export function PromptEditor(props: Props) {
  if (!current || current.getState().id !== props.workflow.id) current = makeStore(props);
  const store = current;
  const view = useStoreBridge(store);
  const refresh = async () => {
    try { store.setState({ progress: await api.workflow.progress.query({ workflowId: view.id }) }); }
    catch (error) { store.setState({ error: asApiError(error).message }); }
  };
  usePolling(() => void refresh(), 2000);
  const save = async () => {
    const definition = { ...view.definition, prompt: view.prompt, resultSchema: parseResultSchemaText(view.schema) };
    const result = await api.workflow.savePrompt.mutate({ workflowId: view.id, expectedVersionId: view.versionId, definition });
    store.setState({ versionId: result.versionId, savedPrompt: view.prompt, definition: { format: "prompt-v1", limits: {}, schedule: null, ...definition } });
  };
  const perform = async (run: boolean) => {
    store.setState({ busy: true, error: null });
    try {
      await save();
      if (run) await api.workflow.trigger.mutate({ workflowId: view.id, requestId: randomUUID(), inputs: view.inputs });
      await refresh();
    } catch (error) { store.setState({ error: asApiError(error).message }); }
    finally { store.setState({ busy: false }); }
  };
  const execution = view.progress?.execution;
  return <div className="prompt-workspace stack">
    <div className="page-heading"><div><span className="eyebrow">Workflow</span><WorkflowName workflowId={view.id} name={props.workflow.name} /></div>
      <Link className="btn" href={`/workflows/${view.id}/runs`}>Run history</Link></div>
    <form className="stack" onSubmit={event => { event.preventDefault(); void perform(false); }}>
      <label className="field"><span>Instructions</span><textarea rows={12} value={view.prompt} maxLength={20000} disabled={view.busy}
        onChange={event => store.setState({ prompt: event.target.value })} placeholder="Describe the complete workflow and the result you want." /></label>
      <details className="advanced-options"><summary>Result format and schedule</summary>
        <label className="field"><span>Result schema (optional JSON Schema)</span><textarea rows={5} value={view.schema} onChange={event => store.setState({ schema: event.target.value })} /></label>
        <p className="muted">{view.definition?.schedule ? `${view.definition.schedule.cron} · ${view.definition.schedule.timezone}` : "Runs manually"}</p>
        <div className="row"><label className="field"><span>Cron schedule (optional)</span><input value={view.definition?.schedule?.cron ?? ""} onChange={event => store.setState({ definition: { format: "prompt-v1", prompt: view.prompt, resultSchema: null, limits: {}, ...view.definition,
          schedule: event.target.value ? { cron: event.target.value, timezone: view.definition?.schedule?.timezone ?? "UTC", enabled: true } : null } })} /></label>
        {view.definition?.schedule ? <label className="field"><span>Timezone</span><input value={view.definition.schedule.timezone} onChange={event => store.setState({ definition: { ...view.definition!, schedule: { ...view.definition!.schedule!, timezone: event.target.value } } })} /></label> : null}</div>
      </details>
      {promptInputNames(view.prompt).map(name => <label key={name} className="field"><span>Run input · {name}</span><input value={view.inputs[name] ?? ""} onChange={event => store.setState({ inputs: { ...view.inputs, [name]: event.target.value } })} /></label>)}
      {view.error ? <p className="banner banner--error" role="alert">{view.error}</p> : null}
      <div className="row"><button disabled={view.busy || !view.prompt.trim()} type="submit">{view.busy ? "Saving…" : "Save prompt"}</button>
        <button className="btn--primary" disabled={view.busy || !view.prompt.trim()} type="button" onClick={() => void perform(true)}>Run workflow</button>
        {execution?.sessionHref ? <Link className="btn" href={execution.sessionHref}>{execution.finished ? "Session replay" : "Watch live"} ↗</Link> : null}</div>
    </form>
    {execution ? <section className="panel stack" aria-label="Latest run"><div className="row"><h2>Latest run</h2><Stamp kind={execution.status} />{execution.finalizationStatus === "running" ? <span className="muted">Summarizing results…</span> : null}</div>
      {execution.summary ? <p style={{ whiteSpace: "pre-wrap" }}>{execution.summary}</p> : <p className="muted">{execution.finished ? "This run has finished." : "Follow the browser session for live updates."}</p>}
      {execution.resultReady ? <pre className="result-output">{JSON.stringify(execution.result, null, 2)}</pre> : null}</section> : null}
  </div>;
}
