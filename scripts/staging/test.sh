#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

check_prerequisites
cluster_exists || die "cluster is not running; run pnpm staging:up first"
kubectl config use-context "kind-${TABDUCTOR_CLUSTER_NAME}" >/dev/null
kubectl -n "${TABDUCTOR_NAMESPACE}" wait --for=condition=available deployment \
  -l "app.kubernetes.io/instance=${TABDUCTOR_RELEASE}" --timeout=3m
helm test "${TABDUCTOR_RELEASE}" --namespace "${TABDUCTOR_NAMESPACE}" --logs --timeout 2m

if [[ "${TABDUCTOR_STAGING_LIVE:-0}" == "1" ]]; then
  [[ -n "${CLERK_SECRET_KEY:-}" ]] || die "CLERK_SECRET_KEY is required for staging:test:live"
  [[ -n "${PADDLE_API_KEY:-}" ]] || die "PADDLE_API_KEY is required for staging:test:live"
  printf 'Live credentials are present. Provider-specific smoke journeys are enabled as their phases land.\n'
fi

printf 'Tabductor staging smoke checks passed.\n'
