#!/bin/sh
# Creates .env with random secrets so `docker compose up -d` works out of the box. Safe to re-run (never overwrites).
set -e
[ -f .env ] && { echo ".env already exists, leaving it alone"; exit 0; }
rnd() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-48; }
cat > .env <<EOT
JWT_SECRET=$(rnd)
POSTGRES_PASSWORD=$(rnd)
LIVEKIT_API_SECRET=$(rnd)
MINIO_ROOT_PASSWORD=$(rnd)
PUBLIC_URL=${PUBLIC_URL:-http://localhost:3000}
# Origins allowed to call the API: the hosted web app and the local dev server.
CORS_ORIGINS=${CORS_ORIGINS:-https://hishamabulfeilat.github.io,http://localhost:5173}
LIVEKIT_URL=${LIVEKIT_URL:-ws://localhost:7880}
EOT
echo "wrote .env"
