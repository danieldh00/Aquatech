#!/usr/bin/env bash
# Update van de stagingomgeving op stg01 (gestart door aquatech-stg-update.timer, elke 10 minuten).
# Haalt het image ghcr.io/danieldh00/aquatech-staging:latest op (gebouwd door staging.yml vanaf develop) en rolt het uit
# als het een andere commit is dan die nu draait (vaste tag develop-<12 tekens van de commit>). Lukt de uitrol niet (niet healthy), dan gaat de vorige tag terug.
# Staging is wegwerp: geen back-up en geen onderhoudsmodus. Migraties zijn alleen toevoegingen, dus terugzetten van het
# image werkt ook na een gemigreerde database.
# De naam van het pakket staat hier vast: dit script kan nooit het productie-image (ghcr.io/danieldh00/aquatech) uitrollen.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech-stg}"
IMAGE="ghcr.io/danieldh00/aquatech-staging"
HEALTH_TRIES="${HEALTH_TRIES:-40}"
TAG_RE='^develop-[0-9a-f]{12}$'

cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

exec 9>"$APP_DIR/.update.lock"
flock -n 9 || { log "Er loopt al een update; overslaan."; exit 0; }

docker pull -q "$IMAGE:latest" >/dev/null
version="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")"
revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:latest")"
[[ -n "$version" ]] || { log "Geen versielabel op het image; overslaan."; exit 1; }
new_tag="develop-${revision:0:12}"
[[ "$new_tag" =~ $TAG_RE ]] || { log "Geen geldige revisie op het image; overslaan."; exit 1; }
current_tag="$(env_get AQUATECH_TAG)"
if [[ "$new_tag" == "$current_tag" ]]; then
  log "Staging draait al $new_tag."
  exit 0
fi

log "Uitrollen: $current_tag -> $new_tag ($version)"
docker pull -q "$IMAGE:$new_tag" >/dev/null
env_set AQUATECH_TAG "$new_tag"
docker compose up -d aquatech

healthy=""
for _ in $(seq 1 "$HEALTH_TRIES"); do
  status="$(docker inspect -f '{{.State.Health.Status}}' aquatech-stg 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then healthy=1; break; fi
  sleep 3
done
if [[ -z "$healthy" ]]; then
  log "Nieuwe staging-versie werd niet healthy; terug naar $current_tag."
  docker logs --tail 40 aquatech-stg || true
  if [[ -n "$current_tag" ]]; then
    env_set AQUATECH_TAG "$current_tag"
    docker compose up -d aquatech
  fi
  exit 1
fi
log "Staging draait nu $new_tag."

# Oude staging-tags opruimen (de draaiende en twee vorige blijven).
for old_tag in $(docker image ls --format '{{.Tag}}' "$IMAGE" | grep -E "$TAG_RE" | sort -r | tail -n +4); do
  docker rmi "$IMAGE:$old_tag" >/dev/null 2>&1 || true
done
