# AWS staging

Target: account `523227112806`, region `ap-southeast-2`. Terraform pins the providers and
modules and refuses another account. Staging uses Clerk development keys and Paddle sandbox.
The AWS account must permit paid EC2 instance types for the baseline and browser NodePool.
The Free plan rejected `m6i.large` and seven-day RDS retention during initial provisioning.
RDS staging currently requests one-day retention; set seven days after upgrading the plan.

`foundation/` provisions the VPC, private EKS nodes, bounded Karpenter identities, private
RDS PostgreSQL 16, encrypted S3, ECR, KMS and Secrets Manager. EKS Pod Identity supplies
short-lived credentials to application services; browser pods receive no AWS identity.
IRSA is disabled because this deployment uses Pod Identity. `edge/` creates a private ALB,
a CloudFront VPC origin and an AWS-generated HTTPS domain. No custom domain purchase is
needed. The same gateway serves the web app and authenticated browser WebSockets.

Prerequisites: AWS CLI v2 with `aws login`, Terraform 1.13, Docker, kubectl, Helm, Python 3
and Node 24. Run from the repository root. The Terraform wrapper refreshes the CLI login
through `credential_process`, avoiding a fixed token expiring during EKS creation.

```sh
python3 scripts/aws/bootstrap-state.py
python3 scripts/aws/terraform.py -chdir=infra/aws/foundation init \
  -backend-config=../../../.tabductor-aws/foundation-backend.hcl
# Set operator_cidr to your public IPv4 /32 in staging.auto.tfvars.json (ignored).
python3 scripts/aws/terraform.py -chdir=infra/aws/foundation plan -out=../../../.tabductor-aws/foundation.tfplan
python3 scripts/aws/terraform.py -chdir=infra/aws/foundation apply ../../../.tabductor-aws/foundation.tfplan
python3 scripts/aws/terraform.py -chdir=infra/aws/edge init \
  -backend-config=../../../.tabductor-aws/edge-backend.hcl
python3 scripts/aws/terraform.py -chdir=infra/aws/edge plan -out=../../../.tabductor-aws/edge.tfplan
python3 scripts/aws/terraform.py -chdir=infra/aws/edge apply ../../../.tabductor-aws/edge.tfplan
python3 scripts/aws/install-platform.py
export KUBECONFIG="$PWD/.tabductor-aws/kubeconfig"
node --env-file=.env scripts/aws/configure.mjs
# Build and validate, then commit before publishing immutable images.
docker build -t tabductor-app:local .
docker build -t tabductor-browser-worker:local -f apps/browser-worker/Dockerfile .
python3 scripts/aws/push-images.py
python3 scripts/aws/deploy.py
python3 scripts/aws/terraform.py -chdir=infra/aws/edge output -raw url
```

Application settings are written directly to Secrets Manager and Kubernetes, outside Helm
release history. `.env`, local keys, state files and credentials are excluded from Docker
contexts. The RDS CA bundle is sourced from AWS's `truststore.pki.rds.amazonaws.com`; the
application verifies the database certificate. The state bucket is encrypted, versioned,
locked and private. Keep KMS keys and their permissions when restoring older snapshots.

The default browser pool has two spare workers, 25 allocated sessions, and a 27-pod cap.
Karpenter's On-Demand pool is bounded at 64 vCPUs/128 GiB. Allocated pods reject voluntary
disruption; terminated workers are deleted so empty nodes can consolidate. Browser egress
policies exclude private, loopback, metadata and cluster destinations. Acceptance must
verify those restrictions from actual worker pods; YAML rendering alone is insufficient.

Before an upgrade, drain workflow executions and browser sessions. The deployment command
stops the application for migrations; do not use it against active customer sessions.
Rollback only to an image compatible with the current schema. For an incompatible migration,
restore RDS into a new instance and verify it before changing the application secret. Retain
the old database and S3 versions until the restore is verified. RDS/KMS/S3 have destroy guards;
do not remove those guards as routine deployment cleanup.

Required launch evidence remains: real Clerk signup/sign-in, Paddle sandbox webhook round
trip, network isolation, 25-browser load/burst fairness, EC2 scale-out/scale-in, forced-node
loss, recording/profile recovery, and bounded live model/proxy/solver checks. A successful
Terraform apply or an HTTP health check does not satisfy those gates.

Sources: [EKS network policies](https://docs.aws.amazon.com/eks/latest/userguide/cni-network-policy-configure.html),
[CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html),
[EKS module](https://github.com/terraform-aws-modules/terraform-aws-eks/tree/v21.25.0),
[AWS load balancer controller policy](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.5.0/docs/install/iam_policy.json).
