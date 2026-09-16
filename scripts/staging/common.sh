#!/usr/bin/env bash
set -Eeuo pipefail

TABDUCTOR_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
TABDUCTOR_STAGING_ROOT="${TABDUCTOR_STAGING_ROOT:-${TABDUCTOR_REPO_ROOT}/.tabductor-staging}"
TABDUCTOR_CLUSTER_NAME="${TABDUCTOR_CLUSTER_NAME:-tabductor-staging}"
TABDUCTOR_NAMESPACE="${TABDUCTOR_NAMESPACE:-tabductor-staging}"
TABDUCTOR_RELEASE="${TABDUCTOR_RELEASE:-staging}"
TABDUCTOR_KUBECONFIG="${TABDUCTOR_STAGING_ROOT}/kubeconfig"
TABDUCTOR_STATE_DIR="${TABDUCTOR_STAGING_ROOT}/state"
TABDUCTOR_IMAGE="${TABDUCTOR_IMAGE:-tabductor-app:local}"
TABDUCTOR_BROWSER_IMAGE="${TABDUCTOR_BROWSER_IMAGE:-tabductor-browser-worker:local}"
TABDUCTOR_CALICO_VERSION="${TABDUCTOR_CALICO_VERSION:-v3.30.3}"

export KUBECONFIG="${TABDUCTOR_KUBECONFIG}"

die() {
  printf 'staging: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing prerequisite: $1"
}

check_prerequisites() {
  need docker
  need kind
  need kubectl
  need helm
  need sed
  docker info >/dev/null 2>&1 || die "the container runtime is not available"
}

cluster_exists() {
  kind get clusters 2>/dev/null | grep -Fxq "${TABDUCTOR_CLUSTER_NAME}"
}

assert_safe_staging_root() {
  case "${TABDUCTOR_STAGING_ROOT}" in
    "${TABDUCTOR_REPO_ROOT}/.tabductor-staging"|"${TABDUCTOR_REPO_ROOT}/.tabductor-staging/"*) ;;
    *) die "refusing to alter staging state outside ${TABDUCTOR_REPO_ROOT}/.tabductor-staging" ;;
  esac
}
