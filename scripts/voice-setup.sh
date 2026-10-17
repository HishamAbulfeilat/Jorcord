#!/usr/bin/env bash
set -euo pipefail

# Ensure docker is available
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker not found. Please install Docker to run LiveKit." >&2
  exit 1
fi

echo "Starting LiveKit via docker compose..."
docker compose -f infra/livekit/docker-compose.yml up -d

echo "LiveKit started. To view logs:"
echo "  docker compose -f infra/livekit/docker-compose.yml logs -f livekit"
echo "To stop LiveKit later:"
echo "  docker compose -f infra/livekit/docker-compose.yml down"