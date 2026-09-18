import { request } from "node:http";
import type { V1Pod } from "@kubernetes/client-node";
import { browserWorkerToken } from "@tabductor/engine";

/** Local Compose adapter. Cloud deployments continue using the Kubernetes API. */
export function dockerFleet(tokenKey: string) {
  const label = "tabductor.local-browser=1";
  const network = process.env.BROWSER_DOCKER_NETWORK ?? "tabductor_default";
  const containerName = (name: string) => {
    if (!/^worker-[a-z0-9-]+$/.test(name)) throw new Error("invalid local worker name");
    return `tabductor-${name}`;
  };
  const call = <T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> => new Promise((resolve, reject) => {
    const req = request({ socketPath: "/var/run/docker.sock", method, path: `/v1.45${path}`, headers: { "content-type": "application/json" } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error("Docker response too large")); else chunks.push(chunk); });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) { reject(Object.assign(new Error(`Docker API status ${res.statusCode}`), { code: res.statusCode })); return; }
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as T : {} as T); } catch { reject(new Error("Invalid Docker response")); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("Docker request timed out")));
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  type Inspection = { Id: string; Name: string; Config: { Labels: Record<string, string> }; State: { Running: boolean }; NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
  const inspect = async (name: string) => {
    const data = await call<Inspection>("GET", `/containers/${containerName(name)}/json`);
    if (data.Config.Labels["tabductor.local-browser"] !== "1") throw new Error("container is not a Tabductor worker");
    return data;
  };
  const pod = (data: Inspection): V1Pod => ({ metadata: { name: data.Name.replace(/^\/tabductor-/, ""), annotations: { "karpenter.sh/do-not-disrupt": "true" } },
    status: { phase: data.State.Running ? "Running" : "Failed", podIP: data.NetworkSettings.Networks[network]?.IPAddress,
      conditions: [{ type: "Ready", status: data.State.Running ? "True" : "False" }] } });
  return {
    async listNamespacedPod(_input: { namespace: string; labelSelector: string }) {
      const rows = await call<Array<{ Id: string }>>("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`);
      const items = await Promise.all(rows.map(async row => pod(await call<Inspection>("GET", `/containers/${row.Id}/json`))));
      return { items };
    },
    async createNamespacedPod({ body }: { namespace: string; body: V1Pod }) {
      const name = body.metadata!.name!;
      await call("POST", `/containers/create?name=${containerName(name)}`, {
        Image: process.env.BROWSER_WORKER_IMAGE ?? "tabductor-browser-worker:local", Labels: { "tabductor.local-browser": "1" },
        Env: [`TABDUCTOR_WORKER_TOKEN=${browserWorkerToken(tokenKey, name)}`],
        HostConfig: { NetworkMode: network, ShmSize: 1024 ** 3, Memory: 3 * 1024 ** 3, NanoCpus: 2e9,
          CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
      });
      await call("POST", `/containers/${containerName(name)}/start`);
      return pod(await inspect(name));
    },
    async deleteNamespacedPod({ name }: { namespace: string; name: string }) {
      await inspect(name);
      await call("DELETE", `/containers/${containerName(name)}?force=1&v=1`);
    },
    async patchNamespacedPod(_input: { namespace: string; name: string; body: unknown }) { /* No autoscaler locally. */ },
  };
}
