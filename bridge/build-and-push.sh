#!/usr/bin/env bash
#
# Build the aloxberry-bridge container image and push it to ghcr.io.
#
# Targets the registry image referenced by bridge/nginx-proxy/docker-compose.yaml
# (`ghcr.io/grestorn/aloxberry-bridge:latest`). The local Caddy-stack deployment
# at bridge/docker-compose.yml uses `build: .` and does NOT need this script;
# `docker compose up -d --build` rebuilds in place there.
#
# Prerequisites:
#   - docker (with BuildKit; default on modern installs)
#   - One-time:  docker login ghcr.io
#     Use a GitHub Personal Access Token with `write:packages` scope as the
#     password. Login persists in ~/.docker/config.json.
#
# Usage:
#   ./bridge/build-and-push.sh                   # build + push :latest and :git-<sha>
#   ./bridge/build-and-push.sh --build-only      # build, no push (smoke test)
#   ./bridge/build-and-push.sh --tag v0.2.0      # also tag + push :v0.2.0
#
# After a successful push, on the bridge host (GKS server):
#   cd /opt/dockerapp/aloxberry-bridge
#   docker compose pull
#   docker compose up -d
#
# To roll back, target the previous git-<sha> tag explicitly in the compose
# `image:` field, then `docker compose up -d`.

set -euo pipefail

REGISTRY=ghcr.io
IMAGE_PATH=grestorn/aloxberry-bridge
IMAGE="${REGISTRY}/${IMAGE_PATH}"

BUILD_ONLY=0
EXTRA_TAG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --build-only) BUILD_ONLY=1; shift ;;
        --tag)        EXTRA_TAG="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f Dockerfile ]]; then
    echo "ERROR: Dockerfile missing — script is not in bridge/" >&2
    exit 1
fi

# Derive an immutable build tag from the current git commit. If we're outside
# a git checkout (rare — CI?), fall back to a timestamp so we still get a
# rollback-able tag.
if GIT_SHA="$(git rev-parse --short=8 HEAD 2>/dev/null)"; then
    BUILD_TAG="git-${GIT_SHA}"
    # Warn — but don't refuse — when the working tree is dirty. Pushing
    # with uncommitted changes makes the git-tag a lie. Common during
    # iterative testing, so soft-warn rather than block.
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
        echo "WARNING: working tree has uncommitted changes — git tag ${BUILD_TAG} won't match HEAD exactly" >&2
    fi
else
    BUILD_TAG="build-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "WARNING: not in a git checkout — using timestamp tag ${BUILD_TAG}" >&2
fi

echo "==> docker build"
echo "    image: ${IMAGE}"
echo "    tags:  latest, ${BUILD_TAG}${EXTRA_TAG:+, ${EXTRA_TAG}}"
echo

BUILD_ARGS=(
    --pull
    --tag "${IMAGE}:latest"
    --tag "${IMAGE}:${BUILD_TAG}"
)
if [[ -n "$EXTRA_TAG" ]]; then
    BUILD_ARGS+=(--tag "${IMAGE}:${EXTRA_TAG}")
fi
BUILD_ARGS+=(--file Dockerfile .)

DOCKER_BUILDKIT=1 docker build "${BUILD_ARGS[@]}"

if [[ "$BUILD_ONLY" -eq 1 ]]; then
    echo
    echo "Build complete. Skipping push (--build-only)."
    echo "To inspect locally:  docker run --rm -e BRIDGE_DISPATCH_SECRET=test ${IMAGE}:latest"
    exit 0
fi

echo
echo "==> docker push"

# Push :latest first — that's what `docker compose pull` on the bridge host
# fetches. If auth fails, surface a clear hint.
if ! docker push "${IMAGE}:latest"; then
    echo
    echo "Push failed. If the error mentions denied / unauthorized:" >&2
    echo "  docker login ghcr.io" >&2
    echo "  (use a GitHub PAT with write:packages scope as the password)" >&2
    exit 1
fi
docker push "${IMAGE}:${BUILD_TAG}"
if [[ -n "$EXTRA_TAG" ]]; then
    docker push "${IMAGE}:${EXTRA_TAG}"
fi

echo
echo "Push complete:"
echo "  ${IMAGE}:latest"
echo "  ${IMAGE}:${BUILD_TAG}"
if [[ -n "$EXTRA_TAG" ]]; then
    echo "  ${IMAGE}:${EXTRA_TAG}"
fi
echo
echo "To deploy on the bridge host:"
echo "  ssh <bridge-host>"
echo "  cd /opt/dockerapp/aloxberry-bridge"
echo "  docker compose pull && docker compose up -d"
echo
echo "To roll back to this build later, set image: ${IMAGE}:${BUILD_TAG}"
echo "in docker-compose.yaml on the bridge host and re-run docker compose up -d."
