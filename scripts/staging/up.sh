#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/common.sh"

check_prerequisites
assert_safe_staging_root
mkdir -p "${TABDUCTOR_STATE_DIR}/postgres" "${TABDUCTOR_STATE_DIR}/minio" "${TABDUCTOR_STATE_DIR}/secrets"
chmod 0777 "${TABDUCTOR_STATE_DIR}/postgres" "${TABDUCTOR_STATE_DIR}/minio" "${TABDUCTOR_STATE_DIR}/secrets"

if ! cluster_exists; then
  rendered_kind="${TABDUCTOR_STAGING_ROOT}/kind.yaml"
  sed "s|__TABDUCTOR_STATE_DIR__|${TABDUCTOR_STATE_DIR}|g" \
    "${TABDUCTOR_REPO_ROOT}/infra/kind/tabductor.yaml" > "${rendered_kind}"
  kind create cluster --name "${TABDUCTOR_CLUSTER_NAME}" --config "${rendered_kind}" --kubeconfig "${TABDUCTOR_KUBECONFIG}"
  kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${TABDUCTOR_CALICO_VERSION}/manifests/calico.yaml"
fi

kubectl wait --for=condition=Ready nodes --all --timeout=180s
docker build -t "${TABDUCTOR_IMAGE}" "${TABDUCTOR_REPO_ROOT}"
docker build -t "${TABDUCTOR_BROWSER_IMAGE}" -f "${TABDUCTOR_REPO_ROOT}/apps/browser-worker/Dockerfile" "${TABDUCTOR_REPO_ROOT}"
kind load docker-image "${TABDUCTOR_IMAGE}" --name "${TABDUCTOR_CLUSTER_NAME}"
kind load docker-image "${TABDUCTOR_BROWSER_IMAGE}" --name "${TABDUCTOR_CLUSTER_NAME}"
kubectl create namespace "${TABDUCTOR_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

chart="${TABDUCTOR_REPO_ROOT}/infra/helm/tabductor"
image_repo="${TABDUCTOR_IMAGE%:*}"
image_tag="${TABDUCTOR_IMAGE##*:}"
browser_image_repo="${TABDUCTOR_BROWSER_IMAGE%:*}"
browser_image_tag="${TABDUCTOR_BROWSER_IMAGE##*:}"

# First reconcile durable services and a one-shot migration with the application stopped.
helm upgrade --install "${TABDUCTOR_RELEASE}" "${chart}" \
  --namespace "${TABDUCTOR_NAMESPACE}" \
  --set-string image.repository="${image_repo}" \
  --set-string image.tag="${image_tag}" \
  --set-string fleet.workerImage="${browser_image_repo}:${browser_image_tag}" \
  --set controlPlane.enabled=false \
  --set migration.enabled=false \
  --wait --timeout 5m
kubectl -n "${TABDUCTOR_NAMESPACE}" delete job "${TABDUCTOR_RELEASE}-tabductor-migrate" --ignore-not-found
helm upgrade "${TABDUCTOR_RELEASE}" "${chart}" \
  --namespace "${TABDUCTOR_NAMESPACE}" \
  --set-string image.repository="${image_repo}" \
  --set-string image.tag="${image_tag}" \
  --set-string fleet.workerImage="${browser_image_repo}:${browser_image_tag}" \
  --set controlPlane.enabled=false \
  --set migration.enabled=true \
  --wait --timeout 5m
kubectl -n "${TABDUCTOR_NAMESPACE}" wait --for=condition=complete \
  "job/${TABDUCTOR_RELEASE}-tabductor-migrate" --timeout=5m

# Start application processes only after the schema is current.
helm upgrade "${TABDUCTOR_RELEASE}" "${chart}" \
  --namespace "${TABDUCTOR_NAMESPACE}" \
  --set-string image.repository="${image_repo}" \
  --set-string image.tag="${image_tag}" \
  --set-string fleet.workerImage="${browser_image_repo}:${browser_image_tag}" \
  --set controlPlane.enabled=true \
  --set migration.enabled=false \
  --wait --timeout 5m

printf 'Tabductor staging is ready at http://127.0.0.1:3000\n'
