import { createHmac } from "node:crypto";
import { CoreV1Api, KubeConfig, type V1Pod } from "@kubernetes/client-node";
import { loadConfig, newId } from "@tabductor/core";
import { createDb } from "@tabductor/db";
import {
  claimBrowserAllocation,
  failBrowserAllocation,
  fulfillBrowserAllocation,
  type ClaimedBrowserAllocation,
} from "@tabductor/engine";

const config = loadConfig();
const namespace = process.env.BROWSER_NAMESPACE ?? "tabductor-staging";
const workerImage = process.env.BROWSER_WORKER_IMAGE ?? "tabductor-browser-worker:local";
const maxAllocated = Number(process.env.BROWSER_MAX_ALLOCATED ?? 3);
const tokenKey = process.env.BROWSER_WORKER_TOKEN_KEY;
if (!tokenKey || tokenKey.length < 32) throw new Error("BROWSER_WORKER_TOKEN_KEY must contain at least 32 characters");

const handle = createDb(config.DATABASE_URL, { max: 4 });
const kubeconfig = new KubeConfig();
kubeconfig.loadFromDefault();
const core = kubeconfig.makeApiClient(CoreV1Api);
let stopping = false;

function workerToken(allocation: ClaimedBrowserAllocation): string {
  return createHmac("sha256", tokenKey!).update(`${allocation.sessionId}:${allocation.generation}`).digest("base64url");
}

function podFor(allocation: ClaimedBrowserAllocation, podName: string): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace,
      labels: {
        "app.kubernetes.io/name": "tabductor-browser",
        "tabductor.io/session-id": allocation.sessionId,
        "tabductor.io/account-id": allocation.accountId,
      },
      annotations: { "karpenter.sh/do-not-disrupt": "true" },
    },
    spec: {
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 30,
      automountServiceAccountToken: false,
      containers: [{
        name: "worker",
        image: workerImage,
        imagePullPolicy: process.env.BROWSER_WORKER_PULL_POLICY ?? "IfNotPresent",
        env: [
          { name: "TABDUCTOR_WORKER_TOKEN", value: workerToken(allocation) },
          { name: "TABDUCTOR_PROFILE_ROOT", value: "/profiles" },
          ...(config.TABDUCTOR_DEPLOYMENT_MODE === "local" ? [{ name: "TABDUCTOR_ALLOW_PRIVATE_EGRESS", value: "1" }] : []),
        ],
        ports: [{ name: "rpc", containerPort: 8080 }],
        readinessProbe: { httpGet: { path: "/healthz", port: "rpc" }, periodSeconds: 2, failureThreshold: 30 },
        resources: {
          requests: { cpu: process.env.BROWSER_CPU_REQUEST ?? "500m", memory: process.env.BROWSER_MEMORY_REQUEST ?? "1Gi" },
          limits: { cpu: process.env.BROWSER_CPU_LIMIT ?? "2", memory: process.env.BROWSER_MEMORY_LIMIT ?? "3Gi" },
        },
        securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
        volumeMounts: [{ name: "profile", mountPath: "/profiles" }, { name: "shm", mountPath: "/dev/shm" }],
      }],
      volumes: [{ name: "profile", emptyDir: {} }, { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } }],
    },
  };
}

async function allocatedCount(): Promise<number> {
  const response = await core.listNamespacedPod({ namespace, labelSelector: "app.kubernetes.io/name=tabductor-browser" });
  return response.items.filter((pod) => !["Succeeded", "Failed"].includes(pod.status?.phase ?? "")).length;
}

async function reconcile(): Promise<void> {
  let capacity = maxAllocated - await allocatedCount();
  while (!stopping && capacity-- > 0) {
    const allocation = await claimBrowserAllocation(handle.db, { maxAllocated });
    if (!allocation) break;
    const workerId = newId("worker");
    const podName = `browser-${allocation.sessionId.replaceAll("_", "-").slice(-42)}-g${allocation.generation}`.toLowerCase();
    try {
      await core.createNamespacedPod({ namespace, body: podFor(allocation, podName) });
      await fulfillBrowserAllocation(handle.db, { ...allocation, workerId, podName });
    } catch (error) {
      await failBrowserAllocation(handle.db, allocation, error instanceof Error ? error.message : String(error));
    }
  }
}

const timer = setInterval(() => void reconcile().catch((error) => {
  process.stderr.write(`fleet reconcile failed: ${String(error)}\n`);
}), 1_000);
timer.unref();
await reconcile();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await handle.close();
}
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
await new Promise<void>(() => {});
