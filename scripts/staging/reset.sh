#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

need kind
assert_safe_staging_root
if cluster_exists; then
  kind delete cluster --name "${TABDUCTOR_CLUSTER_NAME}"
fi

# Resolve and validate the exact directory before removing its children.
mkdir -p "${TABDUCTOR_STAGING_ROOT}"
resolved_root="$(cd "${TABDUCTOR_STAGING_ROOT}" && pwd -P)"
[[ "${resolved_root}" == "${TABDUCTOR_REPO_ROOT}/.tabductor-staging" ]] || \
  die "resolved staging directory is outside the repository"
find "${resolved_root}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
printf 'Tabductor staging cluster and local state were reset.\n'
