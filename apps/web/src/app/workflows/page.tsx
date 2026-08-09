import Link from "next/link";
import { createCaller } from "../../server/router.js";
import { CreateWorkflow } from "./create-workflow.js";

/** Server component: the list is read through the same caller the tests drive. */
export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const workflows = await createCaller().workflow.list();

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Workflows</h1>
        <CreateWorkflow />
      </div>

      {workflows.length === 0 ? (
        <p className="muted">No workflows yet. Create one, then draw a graph.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tasks</th>
              <th>Last run</th>
              <th>Max hops</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link href={`/workflows/${w.id}`}>{w.name}</Link>
                  <div className="mono muted">{w.id}</div>
                </td>
                <td>{w.taskCount}</td>
                <td>
                  {w.lastRunStatus ? (
                    <>
                      <span className={`status status-${w.lastRunStatus}`}>{w.lastRunStatus}</span>{" "}
                      <span className="muted mono">{w.lastRunAt?.toLocaleString()}</span>
                    </>
                  ) : (
                    <span className="muted">never run</span>
                  )}
                </td>
                <td>{w.maxHops}</td>
                <td className="mono muted">{w.currentVersionId ?? "unpublished"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
