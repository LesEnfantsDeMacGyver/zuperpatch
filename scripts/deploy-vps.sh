#!/usr/bin/env bash
set -euo pipefail

host="${VPS_HOST:-vps.frizull.net}"
app_dir="${VPS_APP_DIR:-/opt/zuperpatch}"
branch="${VPS_BRANCH:-main}"
image="${VPS_IMAGE:-zuperpatch:latest}"
container="${VPS_CONTAINER:-zuperpatch}"
network="${VPS_DOCKER_NETWORK:-nginx-proxy-manager_default}"

ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" \
  "APP_DIR='$app_dir' BRANCH='$branch' IMAGE='$image' CONTAINER='$container' NETWORK='$network' bash -s" <<'REMOTE'
set -euo pipefail

cd "$APP_DIR"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

npm ci
npm run build

docker build -f Dockerfile.static -t "$IMAGE" .
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  "$IMAGE"

docker ps --filter "name=^/$CONTAINER$" --format "{{.Names}} {{.Status}} {{.Ports}}"
for attempt in {1..20}; do
  if docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080').then(r=>{console.log(r.status, r.headers.get('content-type')); process.exit(r.ok ? 0 : 1)}).catch(()=>process.exit(1))"; then
    exit 0
  fi
  sleep 1
done

docker logs --tail 80 "$CONTAINER"
exit 1
REMOTE
