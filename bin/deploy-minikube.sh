#!/usr/bin/env bash
# Script: Run the feedback service in a container on minikube (local Kubernetes)
# Purpose: Build the service's image inside minikube, deploy it, and point the local
#          app at it instead of the LocalStack Lambda
# Usage: ./deploy-minikube.sh [up|down]
# Default: up

set -e

if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    echo "Usage: $0 [up|down]"
    echo "Run the feedback service in a container on minikube"
    echo ""
    echo "Arguments:"
    echo "  up              Start minikube if needed, build and deploy the service (default)"
    echo "  down            Send the local app back to the Lambda and remove the deployment"
    echo ""
    echo "Requirements:"
    echo "  - minikube, kubectl and docker installed"
    echo "  - The local environment running (./bin/start-dev.sh): the service uses its PostgreSQL"
    exit 0
fi

export PATH="$HOME/.local/bin:$PATH"
for tool in minikube kubectl docker; do
    command -v "$tool" > /dev/null 2>&1 || { echo "ERROR: '$tool' is missing. Aborting..."; exit 1; }
done

SCRIPT_DIR="$(cd "$(dirname "$0")" > /dev/null 2>&1 || exit 1; pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." > /dev/null 2>&1 || exit 1; pwd -P)"
SERVICE_DIR="$PROJECT_ROOT/backend/feedback"
OVERRIDES="$SCRIPT_DIR/.proxy-overrides.json"
KUBECTL="kubectl --context minikube"   # never touch another cluster this machine may know

echo "====================================="
echo "Coding Workshop - Feedback on minikube"
echo "====================================="
echo ""

if [ "${1:-up}" = "down" ]; then
    rm -f "$OVERRIDES"
    echo "INFO: The local app uses the feedback Lambda again"
    $KUBECTL delete -f "$SERVICE_DIR/k8s.yaml" --ignore-not-found
    $KUBECTL delete secret feedback-db --ignore-not-found
    echo "INFO: Removed from minikube (the cluster itself is left running: 'minikube stop' ends it)"
    exit 0
fi

if ! minikube status > /dev/null 2>&1; then
    echo "INFO: Starting minikube..."
    # Docker's default network: on the workshop machines a network of minikube's own cannot
    # be reached from the workstation, and the default one is where PostgreSQL is reachable too
    minikube start --driver=docker --network=bridge --cpus=2 --memory=2000mb
fi

# The image copies the shared modules from the service folder, so refresh them first
"$SCRIPT_DIR/sync-shared.sh" > /dev/null

echo "INFO: Building the image inside minikube..."
minikube image build -t acme-feedback:local "$SERVICE_DIR"
minikube image ls | grep -q "acme-feedback:local" || { echo "ERROR: The image was not built. Aborting..."; exit 1; }

echo "INFO: Deploying..."
# The database password reaches the pod as a secret, never as text in the manifest
$KUBECTL create secret generic feedback-db --from-literal=password="${POSTGRES_PASS:-postgres123}" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
$KUBECTL apply -f "$SERVICE_DIR/k8s.yaml"
$KUBECTL rollout restart deployment/feedback > /dev/null   # so a rebuilt image is picked up
$KUBECTL rollout status deployment/feedback --timeout=180s

URL="http://$(minikube ip):30080"
echo "INFO: Checking $URL ..."
curl -fsS --retry 5 --retry-delay 2 --retry-connrefused "$URL/" && echo ""

echo "{\"feedback\": \"$URL\"}" > "$OVERRIDES"

echo ""
echo "====================================="
echo "The feedback service is running on minikube: $URL"
echo "The local app (http://localhost:3000) now sends /api/feedback there."
echo "  Pod:   kubectl --context minikube get pods -l app=feedback"
echo "  Logs:  kubectl --context minikube logs deploy/feedback"
echo "  Back to the Lambda:  $0 down"
echo "====================================="
