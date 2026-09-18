import { CoreV1Api, KubeConfig, type V1Pod } from "@kubernetes/client-node";
import { loadConfig, newId } from "@tabductor/core";
import { createDb, browserRecordingSegments, browserAllocationRequests, browserBilling, browserProfiles, browserProfileLeases, browserSessions, browserWorkers } from "@tabductor/db";
import { createMinioBlobStore } from "@tabductor/browser";
import { encryptEnvelope, fileKeyWrapper, withEnvelope, type EncryptedEnvelope } from "@tabductor/secrets";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { claimBrowserAllocation, failBrowserAllocation, fulfillBrowserAllocation, endBrowserSession, browserWorkerToken,
  browserCreditAdmission, settleBrowserUsage, acknowledgeBrowserPause, expireBrowserTakeovers, stopBrowserSession, appendBrowserRecordingSegment, expireBrowserRecordings } from "@tabductor/engine";

const config = loadConfig();
const namespace = process.env.BROWSER_NAMESPACE ?? "tabductor-staging";
const maxAllocated = Number(process.env.BROWSER_MAX_ALLOCATED ?? 3);
const warmSlots = Number(process.env.BROWSER_WARM_SLOTS ?? 1);
if (!Number.isSafeInteger(maxAllocated) || maxAllocated < 1 || !Number.isSafeInteger(warmSlots) || warmSlots < 0) throw new Error("invalid fleet capacity");
const tokenKey = process.env.BROWSER_WORKER_TOKEN_KEY;
if (!tokenKey || tokenKey.length < 32) throw new Error("BROWSER_WORKER_TOKEN_KEY must contain at least 32 characters");
const admission = config.TABDUCTOR_FIXTURE_MODE ? undefined : browserCreditAdmission({
  version: process.env.BROWSER_RATE_VERSION ?? "", unitsPerMinute: Number(process.env.BROWSER_UNITS_PER_MINUTE), maxSeconds: Number(process.env.BROWSER_MAX_SECONDS ?? 1800),
});
const handle = createDb(config.DATABASE_URL, { max: 8 });
const blobs = createMinioBlobStore({ endpoint: config.BLOB_ENDPOINT, accessKey: config.BLOB_ACCESS_KEY, secretKey: config.BLOB_SECRET_KEY, bucket: config.BLOB_BUCKET });
const wrapper = fileKeyWrapper(config.SECRETS_KEK_FILE_PATH);
const kubeconfig = new KubeConfig();
kubeconfig.loadFromDefault();
const core = kubeconfig.makeApiClient(CoreV1Api);
let stopping = false;
let inFlight: Promise<void> | undefined;

function podFor(podName: string): V1Pod {
  return { apiVersion: "v1", kind: "Pod", metadata: { name: podName, namespace,
    labels: { "app.kubernetes.io/name": "tabductor-browser" }, annotations: { "karpenter.sh/do-not-disrupt": "true" } },
    spec: { restartPolicy: "Never", terminationGracePeriodSeconds: 30, automountServiceAccountToken: false,
      containers: [{ name: "worker", image: process.env.BROWSER_WORKER_IMAGE ?? "tabductor-browser-worker:local", imagePullPolicy: process.env.BROWSER_WORKER_PULL_POLICY ?? "IfNotPresent",
        env: [{ name: "TABDUCTOR_WORKER_TOKEN", value: browserWorkerToken(tokenKey!, podName) }, { name: "TABDUCTOR_PROFILE_ROOT", value: "/profiles" },
          ...(config.TABDUCTOR_FIXTURE_MODE ? [{ name: "TABDUCTOR_ALLOW_PRIVATE_EGRESS", value: "1" }] : [])],
        ports: [{ name: "rpc", containerPort: 8080 }],
        readinessProbe: { httpGet: { path: "/healthz", port: "rpc" }, periodSeconds: 2, failureThreshold: 30 },
        resources: { requests: { cpu: process.env.BROWSER_CPU_REQUEST ?? "500m", memory: process.env.BROWSER_MEMORY_REQUEST ?? "1Gi" }, limits: { cpu: process.env.BROWSER_CPU_LIMIT ?? "2", memory: process.env.BROWSER_MEMORY_LIMIT ?? "3Gi" } },
        securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, capabilities: { drop: ["ALL"] } },
        volumeMounts: [{ name: "profile", mountPath: "/profiles" }, { name: "shm", mountPath: "/dev/shm" }] }],
      volumes: [{ name: "profile", emptyDir: {} }, { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } }] } };
}

async function rpc(podName: string, url: string, path: string, method: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${browserWorkerToken(tokenKey!, podName)}`,
    "x-tabductor-rpc-version": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`worker RPC failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}

async function syncRecording(sessionId: string, generation: number, podName: string, url: string) {
  const [last] = await handle.db.select({ sequence: browserRecordingSegments.sequence }).from(browserRecordingSegments)
    .where(eq(browserRecordingSegments.sessionId, sessionId)).orderBy(desc(browserRecordingSegments.sequence)).limit(1);
  const result = await rpc(podName, url, `/v1/sessions/${sessionId}/recording?after=${last?.sequence ?? -1}`, "GET");
  const segments = result.segments as Array<{ sequence: number; start_ms: number; end_ms: number; status: "ready" | "private"; bytes?: string }>;
  for (const segment of segments) {
    let objectRef: string | undefined;
    if (segment.status === "ready" && segment.bytes) {
      const encrypted = await encryptEnvelope(wrapper, Buffer.from(segment.bytes, "base64"));
      objectRef = await blobs.put(Buffer.from(JSON.stringify(encrypted)), { mime: "application/json" });
    }
    await appendBrowserRecordingSegment(handle.db, { sessionId, generation, sequence: segment.sequence,
      startMs: segment.start_ms, endMs: Math.max(segment.start_ms + 1, segment.end_ms), status: segment.status, ...(objectRef ? { objectRef } : {}) });
  }
  return result.finished === true && segments.length < 8;
}

async function reconcile(): Promise<void> {
  // A connection-scoped leader lock survives individual bookkeeping transactions. Never overlap controllers.
  const leader = await handle.pool.connect();
  try {
    const lock = await leader.query<{ locked: boolean }>("select pg_try_advisory_lock(7023165) as locked");
    if (!lock.rows[0]?.locked) return;
    try {
      await expireBrowserTakeovers(handle.db);
      await expireBrowserRecordings(handle.db, blobs);
      const podList = await core.listNamespacedPod({ namespace, labelSelector: "app.kubernetes.io/name=tabductor-browser" });
      const pods = new Map(podList.items.map((pod) => [pod.metadata!.name!, pod]));
      const workers = await handle.db.select().from(browserWorkers).where(inArray(browserWorkers.status, ["warm", "allocated", "draining"]));
      // Reconcile recorded worker intent first. Lost create responses are adopted by the same pod name.
      for (const worker of workers) {
        try {
        let pod = pods.get(worker.podName);
        if (!pod && worker.status === "warm") {
          if (pods.size >= maxAllocated + warmSlots) continue;
          try { pod = await core.createNamespacedPod({ namespace, body: podFor(worker.podName) }); pods.set(worker.podName, pod); }
          catch (error) { if ((error as { code?: number }).code !== 409) throw error; continue; }
        }
        const [session] = worker.sessionId ? await handle.db.select().from(browserSessions).where(eq(browserSessions.id, worker.sessionId)) : [];
        const dead = !pod || ["Succeeded", "Failed"].includes(pod.status?.phase ?? "");
        if (worker.status === "draining" || session && ["ended", "failed"].includes(session.status)) {
          if (pod) { await core.deleteNamespacedPod({ namespace, name: worker.podName }); continue; }
          await handle.db.update(browserWorkers).set({ status: "dead" }).where(eq(browserWorkers.id, worker.id));
          if (session) await settleBrowserUsage(handle.db, session.id);
          continue;
        }
        if (dead) {
          if (session) {
            await handle.db.update(browserSessions).set({ error: "browser_outcome_uncertain" }).where(eq(browserSessions.id, session.id));
            await endBrowserSession(handle.db, session.id);
            await settleBrowserUsage(handle.db, session.id);
          }
          if (pod) await core.deleteNamespacedPod({ namespace, name: worker.podName });
          await handle.db.update(browserWorkers).set({ status: "dead" }).where(eq(browserWorkers.id, worker.id));
          continue;
        }
        if (!pod?.status?.podIP || !pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True")) continue;
        const url = `http://${pod.status.podIP}:8080`;
        await handle.db.update(browserWorkers).set({ endpointUrl: url }).where(eq(browserWorkers.id, worker.id));
        if (!session) {
          await handle.db.update(browserWorkers).set({ heartbeatAt: sql`now()` }).where(eq(browserWorkers.id, worker.id));
          continue;
        }
        const [billing] = await handle.db.select().from(browserBilling).where(eq(browserBilling.sessionId, session.id));
        if (billing && Date.now() - billing.startedAt.getTime() >= billing.maxSeconds * 1000 && session.status !== "stopping") {
          await stopBrowserSession(handle.db, { accountId: session.accountId, sessionId: session.id });
          continue;
        }
        if (session.status === "allocating") {
          const [profile] = await handle.db.select().from(browserProfiles).where(eq(browserProfiles.id, session.profileId));
          const start = async (snapshot?: string) => rpc(worker.podName, url, "/v1/sessions", "POST", {
            session_id: session.id, generation: session.generation, profile_dir: session.profileId,
            fingerprint: profile!.fingerprintJson, ...(snapshot ? { snapshot } : {}),
          });
          if (profile!.snapshotBlobRef) {
            const envelope = JSON.parse((await blobs.get(profile!.snapshotBlobRef)).toString()) as EncryptedEnvelope;
            await withEnvelope(wrapper, envelope, (bytes) => start(bytes.toString("base64")));
          } else await start();
          const [allocation] = await handle.db.select().from(browserAllocationRequests).where(and(eq(browserAllocationRequests.sessionId, session.id), eq(browserAllocationRequests.status, "claimed")));
          if (allocation) await fulfillBrowserAllocation(handle.db, { requestId: allocation.id, accountId: session.accountId, sessionId: session.id, profileId: session.profileId, generation: session.generation, workerId: worker.id, podName: worker.podName });
        } else if (session.status === "stopping") {
          const result = await rpc(worker.podName, url, `/v1/sessions/${session.id}?generation=${session.generation}`, "DELETE");
          if (!await syncRecording(session.id, session.generation, worker.podName, url)) continue;
          if (typeof result.snapshot !== "string") throw new Error("worker did not return a clean profile snapshot");
          const envelope = await encryptEnvelope(wrapper, Buffer.from(result.snapshot, "base64"));
          const ref = await blobs.put(Buffer.from(JSON.stringify(envelope)), { mime: "application/json" });
          await handle.db.transaction(async (trx) => {
            const [lease] = await trx.select().from(browserProfileLeases).where(and(eq(browserProfileLeases.sessionId, session.id), eq(browserProfileLeases.generation, session.generation))).for("update");
            if (!lease) throw new Error("profile ownership ended before snapshot publication");
            await trx.update(browserProfiles).set({ snapshotBlobRef: ref, snapshotGeneration: sql`${browserProfiles.snapshotGeneration} + 1`, updatedAt: sql`now()` }).where(eq(browserProfiles.id, session.profileId));
            await endBrowserSession(trx, session.id);
          });
          await settleBrowserUsage(handle.db, session.id);
        } else {
          await syncRecording(session.id, session.generation, worker.podName, url);
          const owner = session.inputOwner === "paused" && session.pauseRequestedAt && !session.pauseAcknowledgedAt ? "human" : session.inputOwner;
          await rpc(worker.podName, url, `/v1/sessions/${session.id}/control`, "POST", { generation: session.generation, input_generation: session.inputOwnerGeneration, owner });
          if (owner === "human" && session.inputOwner === "paused") await acknowledgeBrowserPause(handle.db, { sessionId: session.id, generation: session.generation, inputOwnerGeneration: session.inputOwnerGeneration });
          await handle.db.update(browserSessions).set({ heartbeatAt: sql`now()` }).where(eq(browserSessions.id, session.id));
        }
        await handle.db.update(browserWorkers).set({ heartbeatAt: sql`now()` }).where(eq(browserWorkers.id, worker.id));
        } catch {
          // A failed worker must not stop reconciliation for healthy sessions. Retain ownership
          // until Kubernetes confirms deletion; never start a replacement on an ambiguous RPC.
          if (Date.now() - worker.heartbeatAt.getTime() > 180_000) {
            try { await core.deleteNamespacedPod({ namespace, name: worker.podName }); } catch { /* Reconcile disappearance next tick. */ }
          }
        }
      }
      // Attach a queued request to a clean worker transactionally; no pod is shared or recycled.
      const idle = await handle.db.select().from(browserWorkers).where(and(eq(browserWorkers.status, "warm"), isNull(browserWorkers.sessionId)));
      for (const worker of idle) {
        const bound = await handle.db.transaction(async (trx) => {
          const allocation = await claimBrowserAllocation(trx, { maxAllocated, ...(admission ? { admission } : {}) });
          if (!allocation) return false;
          await trx.update(browserWorkers).set({ status: "allocated", sessionId: allocation.sessionId, generation: allocation.generation }).where(eq(browserWorkers.id, worker.id));
          await trx.update(browserSessions).set({ podName: worker.podName, workerId: worker.id }).where(eq(browserSessions.id, allocation.sessionId));
          return true;
        });
        if (!bound) break;
      }
      // A controller crash between claim and worker binding leaves a recoverable allocation.
      const stranded = await handle.db.select({ session: browserSessions, request: browserAllocationRequests }).from(browserSessions)
        .innerJoin(browserAllocationRequests, eq(browserAllocationRequests.sessionId, browserSessions.id))
        .where(and(eq(browserSessions.status, "allocating"), isNull(browserSessions.workerId)));
      for (const { session, request } of stranded) {
        await failBrowserAllocation(handle.db, { requestId: request.id, sessionId: session.id, profileId: session.profileId, accountId: session.accountId, generation: session.generation }, "allocation interrupted before worker binding", false);
        await settleBrowserUsage(handle.db, session.id);
      }
      const count = await handle.db.select({ count: sql<number>`count(*)::int` }).from(browserWorkers).where(inArray(browserWorkers.status, ["warm", "allocated", "draining"]));
      const warm = await handle.db.select({ count: sql<number>`count(*)::int` }).from(browserWorkers).where(eq(browserWorkers.status, "warm"));
      const queued = await handle.db.select({ count: sql<number>`count(*)::int` }).from(browserAllocationRequests).where(eq(browserAllocationRequests.status, "queued"));
      const desiredWarm = Math.max(warmSlots, queued[0]!.count > 0 ? 1 : 0);
      const needed = Math.min(desiredWarm - warm[0]!.count, maxAllocated + warmSlots - count[0]!.count);
      for (let n = 0; n < needed; n++) {
        const id = newId("worker");
        await handle.db.insert(browserWorkers).values({ id, podName: id.replaceAll("_", "-").toLowerCase() });
      }
    } finally { await leader.query("select pg_advisory_unlock(7023165)"); }
  } finally { leader.release(); }
}
function tick() {
  if (stopping || inFlight) return;
  inFlight = reconcile().catch(() => { process.stderr.write("fleet reconciliation failed; persisted ownership retained for retry\n"); }).finally(() => { inFlight = undefined; });
}
const timer = setInterval(tick, 1000);
tick();
async function shutdown() { if (stopping) return; stopping = true; clearInterval(timer); await inFlight; await handle.close(); }
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
