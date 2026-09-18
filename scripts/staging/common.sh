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

check_cluster_capacity() {
  local staging_cpus staging_memory staging_available_kib
  read -r staging_cpus staging_memory < <(docker info --format '{{.NCPU}} {{.MemTotal}}')
  (( staging_cpus >= 4 && staging_memory >= 12884901888 )) || die "three-browser staging requires at least 4 Docker CPUs and 12 GiB RAM"
  staging_available_kib="$(df -Pk "${TABDUCTOR_REPO_ROOT}" | awk 'NR == 2 {print $4}')"
  (( staging_available_kib >= 31457280 )) || die "staging builds require at least 30 GiB free disk space"
  # These are shared host limits: report the required change instead of silently changing
  # settings used by unrelated applications. Low values can break node join or kube-proxy.
  if [[ -r /proc/sys/fs/inotify/max_user_instances ]]; then
    local instances watches
    read -r instances < /proc/sys/fs/inotify/max_user_instances
    read -r watches < /proc/sys/fs/inotify/max_user_watches
    (( instances >= 512 && watches >= 524288 )) || die \
      "inotify limits are too low for three nodes; run sudo sysctl -w fs.inotify.max_user_instances=512 fs.inotify.max_user_watches=524288"
  fi
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
