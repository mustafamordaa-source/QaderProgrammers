#!/usr/bin/env bash
# Build and (re)start TaskFlow, then wait for the API to answer.
#
# The deploy workflow runs this on the staging server after each push to main.
# To redeploy by hand, run it from the repo root on the server:
#   ./scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

env_file="${TASKFLOW_ENV_FILE:-/opt/docker/taskflow/.env}"
if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example there and fill it in." >&2
  exit 1
fi

if ! docker network inspect qader_qader_network >/dev/null 2>&1; then
  echo "Missing Docker network qader_qader_network. Is the Qader stack running?" >&2
  exit 1
fi

docker compose up -d --build --remove-orphans

echo "Waiting for the API..."
for _ in $(seq 1 20); do
  if docker exec taskflow_web wget -qO- http://127.0.0.1/api/health; then
    echo
    docker image prune -f >/dev/null
    echo "TaskFlow is up."
    exit 0
  fi
  sleep 3
done

echo "Health check failed." >&2
docker compose logs --tail 50 api web
exit 1
