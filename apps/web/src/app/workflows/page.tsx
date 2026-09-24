import Link from "next/link";
import { Stamp } from "../../components/primitives.js";
import { createServerCaller } from "../../server/router.js";
import { CreateWorkflow } from "./create-workflow.js";

/** Server component: the list is read through the same caller the tests drive. */
export const dynamic = "force-dynamic";
export const metadata = { title: "Workflows" };

export default async function WorkflowsPage() {
  const workflows = await (await createServerCaller()).workflow.list();

  return (
    <div className="workflows-page">
      <div className="page-heading">
        <div><span className="eyebrow">Automation workspace</span><h1>Workflows<span className="heading-count">{workflows.length.toString().padStart(2, "0")}</span></h1>
        <p className="muted">From an idea to a browser in motion.</p></div>
        <Link className="btn" href="/sessions">View sessions ↗︎</Link>
      </div>
      <section className="workflow-launch" aria-label="Create a workflow">
        <div className="workflow-launch__intro"><span className="section-label">01 / Create</span><h2>Set things<br /> in motion.</h2><p>Describe a routine.<br /> Let your browser handle it.</p><span className="launch-path">Prompt <span>→</span> Run <span>→</span> Watch live</span></div>
        <CreateWorkflow />
      </section>
      <div className="section-heading"><h2>Your workflows</h2><span className="muted">{workflows.length} total</span></div>
      <div className="table-scroll">
      <table className="ledger">
        <thead>
          <tr>
            <th>Name</th>
            <th>Last run</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {workflows.map((w) => (
            <tr key={w.id}>
              <td>
                <Link
                  href={`/workflows/${w.id}`}
                  style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)", fontWeight: 500 }}
                >
                  {w.name}
                </Link>
              </td>
              <td>
                {w.lastRunStatus ? (
                  <span className="row">
                    <Stamp kind={w.lastRunStatus} />
                    <span className="muted mono" style={{ fontSize: "var(--text-xs)" }}>
                      {w.lastRunAt?.toLocaleString()}
                    </span>
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td><span className="publication-state">{w.currentVersionId ? "Published" : "Draft"}</span></td>
              <td><Link className="btn btn--quiet" href={`/workflows/${w.id}/runs`}>View runs ↗︎</Link></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {!workflows.length ? <div className="empty-workflows"><h2>Your first workflow starts above.</h2><p className="muted">Once created, your workflows and their latest runs appear here.</p></div> : null}
    </div>
  );
}
