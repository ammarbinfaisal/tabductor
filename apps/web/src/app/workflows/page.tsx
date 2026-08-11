import Link from "next/link";
import { Stamp } from "../../components/primitives.js";
import { createCaller } from "../../server/router.js";
import { CreateWorkflow } from "./create-workflow.js";

/** Server component: the list is read through the same caller the tests drive. */
export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const workflows = await createCaller().workflow.list();

  if (workflows.length === 0) {
    return (
      <div className="stack" style={{ alignItems: "center", paddingTop: "var(--space-9)", textAlign: "center" }}>
        <h1 style={{ fontSize: "var(--text-3xl)", fontWeight: 500 }}>
          Describe it. Publish it. Watch it run.
        </h1>
        <p className="muted" style={{ maxWidth: "42ch" }}>
          A workflow is events you describe and nodes you prompt — no schemas, no wiring.
        </p>
        <CreateWorkflow />
      </div>
    );
  }

  return (
    <>
      <div className="row row--between" style={{ marginBottom: "var(--space-5)" }}>
        <h1 style={{ fontSize: "var(--text-xl)" }}>Workflows</h1>
        <CreateWorkflow />
      </div>

      <table className="ledger">
        <thead>
          <tr>
            <th>Name</th>
            <th>Tasks</th>
            <th>Last run</th>
            <th>Version</th>
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
              <td style={{ textAlign: "right" }}>{w.taskCount}</td>
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
              <td className="mono muted">{w.currentVersionId ?? "draft"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
