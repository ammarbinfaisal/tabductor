#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

need kind
assert_safe_staging_root
if cluster_exists; then
  kind delete cluster --name "${TABDUCTOR_CLUSTER_NAME}"
fi
printf 'Tabductor staging stopped; data remains in %s\n' "${TABDUCTOR_STATE_DIR}"
