import { createCaller } from "../../server/router.js";

/**
 * The smoke page (S2c): a server component reading through the same caller the tests use.
 * No client fetch, no hooks — if this renders, the composition root is wired.
 */
export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const api = createCaller();
  const workflows = await api.workflow.list();
  const runs = await api.run.list({ limit: 1 });
  const engine = await api.engine.status();
  const productExecutors = engine.executors.filter((key) => !key.endsWith(":stub"));

  return (
    <>
      <h1>Status</h1>
      <p className="muted">
        {workflows.length} workflow(s); {runs.items.length ? "runs recorded" : "no runs yet"}.
      </p>

      <section>
        <h3>Engine</h3>
        {engine.heartbeatAt === null ? (
          <p className="muted">The engine has never reported — is the engine process running against this database?</p>
        ) : (
          <>
            <p className="muted">
              {engine.stale ? (
                <span className="status status-failed">not heartbeating</span>
              ) : (
                <span className="status status-succeeded">alive</span>
              )}{" "}
              — executors registered at boot (internal work with an unavailable runtime fails{" "}
              <code>no_executor</code>):
            </p>
            <div className="row">
              {productExecutors.map((k) => (
                <span key={k} className="chip mono">
                  {k}
                </span>
              ))}
            </div>
          </>
        )}
      </section>
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Internal steps</th>
            <th>Last run</th>
            <th>Id</th>
          </tr>
        </thead>
        <tbody>
          {workflows.map((w) => (
            <tr key={w.id}>
              <td>{w.name}</td>
              <td>{w.taskCount}</td>
              <td>
                {w.lastRunStatus ? (
                  <span className={`status status-${w.lastRunStatus}`}>{w.lastRunStatus}</span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="mono muted">{w.id}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
