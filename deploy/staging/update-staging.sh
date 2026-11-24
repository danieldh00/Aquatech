#!/usr/bin/env bash
# Staging bijwerken op stg01 (aquatech-staging-update.timer, elke 10 minuten): haalt ghcr.io/danieldh00/aquatech-staging:latest
# op en vervangt de container als er een nieuw image is. Anders dan deploy/apps01/update.sh: geen onderhoudsmodus, geen
# back-up en geen cosign (staging bevat alleen testdata); wel een healthcheck met terugval naar het vorige image.
# Rolt NOOIT het productie-image `aquatech` uit.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech-staging}"
IMAGE="ghcr.io/danieldh00/aquatech-staging:latest"
HEALTH_TRIES="${HEALTH_TRIES:-40}"

cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
exec 9>"$APP_DIR/.update.lock"
flock -n 9 || { log "Er loopt al een update; overslaan."; exit 0; }

old_id="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
docker pull -q "$IMAGE" >/dev/null || { log "Ophalen mislukt; later opnieuw."; exit 0; }
new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE")"
running_id="$(docker inspect -f '{{.Image}}' aquatech-staging 2>/dev/null || true)"
if [[ "$new_id" == "$running_id" ]]; then
  log "Staging is actueel."
  exit 0
fi

log "Nieuw stagingimage ${new_id:7:12}; container vervangen."
docker compose up -d --remove-orphans aquatech >/dev/null
for _ in $(seq 1 "$HEALTH_TRIES"); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' aquatech-staging 2>/dev/null || true)" == "healthy" ]] && { log "Staging draait de nieuwe versie."; exit 0; }
  sleep 3
done

log "FOUT: nieuwe versie wordt niet healthy."
if [[ -n "$old_id" && "$old_id" != "$new_id" ]]; then
  docker tag "$old_id" "$IMAGE"
  docker compose up -d aquatech >/dev/null || true
  log "Teruggezet naar het vorige image."
fi
exit 1
