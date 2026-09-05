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
              — executors registered at boot (a node whose kind:mode is not listed fails{" "}
              <code>no_executor</code>):
            </p>
            <div className="row">
              {engine.executors.map((k) => (
                <span key={k} className="chip mono">
                  {k}
                </span>
              ))}
              {engine.capabilities.map((k) => (
                <span key={k} className="chip mono" title="tool-level ability, not a kind:mode pair">
                  tool {k}
                </span>
              ))}
            </div>
            {!engine.capabilities.includes("python.run") ? (
              <p className="muted">
                <code>python.run</code> is not configured (no <code>PYRUNNER_URL</code>): asset nodes keep the tool but it
                reports itself unavailable.
              </p>
            ) : null}
          </>
        )}
      </section>
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Tasks</th>
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
