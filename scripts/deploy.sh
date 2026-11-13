#!/usr/bin/env bash
# Test, back up, build and (re)start TaskFlow, then wait for the API to answer.
#
# The deploy workflow runs this on the staging server after each push to main.
# To redeploy by hand, run it from the repo root on the server:
#   ./scripts/deploy.sh
#
# Order matters:
#   1. take the shared deploy lock, so this never builds while the Qader
#      staging deploy builds (the server ran out of memory that way once);
#   2. wait for enough free memory;
#   3. run the test suite inside a throwaway image (no hosted Actions minutes);
#   4. back up the database from the running container;
#   5. rebuild and restart; the new API container migrates the schema first;
#   6. health check, or print the logs and the restore command.
set -euo pipefail

cd "$(dirname "$0")/.."

env_file="${TASKFLOW_ENV_FILE:-/opt/docker/taskflow/.env}"
lock_file="${DEPLOY_LOCK:-/tmp/qader-deploy.lock}"
min_free_mb="${DEPLOY_MIN_FREE_MB:-2048}"
wait_minutes="${DEPLOY_WAIT_MINUTES:-15}"
backup_dir=/data/backups
sha="$(git rev-parse --short HEAD 2>/dev/null || echo manual)"

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.example there and fill it in." >&2
  exit 1
fi

if ! docker network inspect qader_qader_network >/dev/null 2>&1; then
  echo "Missing Docker network qader_qader_network. Is the Qader stack running?" >&2
  exit 1
fi

# 1. Shared lock. The Qader staging deploy takes the same file.
exec 9>"$lock_file"
echo "Waiting for the deploy lock ($lock_file)..."
if ! flock -w $((wait_minutes * 60)) 9; then
  echo "Another deploy held the lock for ${wait_minutes} minutes. Try again later." >&2
  exit 1
fi

# 2. Free memory.
deadline=$(( $(date +%s) + wait_minutes * 60 ))
while :; do
  free_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [ "$free_mb" -ge "$min_free_mb" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Only ${free_mb} MB free after ${wait_minutes} minutes (need ${min_free_mb}). Not building." >&2
    exit 1
  fi
  echo "Only ${free_mb} MB free; waiting for ${min_free_mb} MB..."
  sleep 30
done

# 3. Tests, in a build stage. Nothing running changes if they fail.
echo "Running the test suite..."
docker build --target test -t taskflow-api-test ./backend
docker image rm taskflow-api-test >/dev/null 2>&1 || true

# 4. Backup from the running container (stdlib only, so it works with any
#    older image too). Keeps the newest 14.
if docker ps --format '{{.Names}}' | grep -qx taskflow_api; then
  echo "Backing up the database..."
  docker exec taskflow_api python -c "
import os, sqlite3, time, glob
src = '/data/taskflow.db'
if os.path.exists(src):
    os.makedirs('$backup_dir', exist_ok=True)
    out = '$backup_dir/taskflow-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-pre-deploy-$sha.db'
    a = sqlite3.connect(src); b = sqlite3.connect(out); a.backup(b); b.close(); a.close()
    print(out)
    for old in sorted(glob.glob('$backup_dir/taskflow-*.db'))[:-14]:
        os.remove(old)
"
  # Attachments are stored by content hash and never rewritten, so one
  # rolling copy is enough.
  docker exec taskflow_api sh -c "[ -d /data/files ] && mkdir -p $backup_dir/files && cp -rn /data/files/. $backup_dir/files/ || true"
else
  echo "taskflow_api is not running; skipping the backup."
fi

# 5. Build and restart. The API container runs `python migrate.py` first.
docker compose up -d --build --remove-orphans

# 6. Health check.
echo "Waiting for the API..."
for _ in $(seq 1 30); do
  if docker exec taskflow_web wget -qO- http://127.0.0.1/api/health; then
    echo
    docker image prune -f >/dev/null
    echo "TaskFlow is up."
    exit 0
  fi
  sleep 3
done

echo "Health check failed." >&2
docker compose logs --tail 80 api web
cat >&2 <<EOF

To go back to the database as it was before this deploy:
  docker compose stop api
  docker run --rm -v taskflow_taskflow_data:/data alpine sh -c 'ls -1 $backup_dir | tail -3'
  docker run --rm -v taskflow_taskflow_data:/data alpine cp $backup_dir/<newest pre-deploy file> /data/taskflow.db
  git checkout <previous commit> && docker compose up -d --build
EOF
exit 1
