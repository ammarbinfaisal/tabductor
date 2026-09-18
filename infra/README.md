# Development and staging

Docker Compose remains the fast CDP development environment. It runs PostgreSQL on
`127.0.0.1:5434`, MinIO on `127.0.0.1:9002`, the engine and the web app. Existing database
and wrapping-key volumes survive ordinary restarts. Account-selected models supply all
model phases; platform model rates must be configured explicitly. Hosted deployments use
Clerk authentication, managed Camoufox workers and KMS wrapping.

```sh
docker compose up -d
pnpm build
pnpm lint
pnpm exec vitest run --maxWorkers=4
```

The dedicated Kubernetes environment uses the shared Helm chart, Calico and a three-node
kind cluster. Install Docker, kind, kubectl and Helm. Allow at least 4 CPUs, 12 GiB of RAM
and 30 GiB of free disk for the configured three-browser capacity and application builds.
On Linux, three nodes also require `fs.inotify.max_user_instances >= 512` and
`fs.inotify.max_user_watches >= 524288`. The preflight reports the `sudo sysctl` command if
those host limits are too low. Its kubeconfig, PostgreSQL, MinIO and development wrapping key live under
`.tabductor-staging/`; it does not use the Compose database.

```sh
pnpm staging:up
pnpm staging:test
pnpm staging:down       # preserves host-backed state
pnpm staging:reset      # removes only dedicated staging data
```

The loopback gateway is `http://127.0.0.1:3100`. A repeated up rebuilds images and reconciles
the chart; it stops the application while migrating, so drain sessions first. The current
Helm smoke check establishes readiness; the complete fixture journey in
`docs/impl-phases.md` remains a separate acceptance gate. `staging:test:live` exits with an
explicit incomplete-journey error instead of treating credential presence as a pass.

A real browser smoke uses disposable containers and a fixture website. It verifies login
persistence after replacement, fingerprint stability, perception, command fencing,
takeover/resume and playable/private recording segments without paid provider calls:

```sh
docker build -t tabductor-browser-worker:local -f apps/browser-worker/Dockerfile .
python3 scripts/browser/smoke.py
python3 -m unittest discover -s apps/browser-worker/tests -v
```

[AWS staging instructions](aws/README.md) provision EKS/RDS/S3/KMS/ECR and an AWS-generated
HTTPS domain. AWS acceptance additionally requires real node autoscaling and managed-service
failure checks. Local kind cannot establish those results.
