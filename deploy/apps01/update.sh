#!/usr/bin/env bash
# Auto-update van Aquatech op apps01 (systemd-timer aquatech-update.timer).
#
# Kijkt welke versie :latest in GHCR heeft. Is die nieuwer dan AQUATECH_TAG in
# .env, dan: image ophalen, back-up van de database, container vervangen en
# wachten op healthy. Lukt dat niet, dan terug naar de vorige versie, en wordt
# die versie overgeslagen tot er een nieuwere is.
#
# Database in Supabase (DATABASE_URL_FILE in compose.yml): vooraf een
# versleutelde back-up in data/backups (zichtbaar in Beheer -> Instellingen);
# bij terugvallen wordt alleen de image teruggezet (migraties zijn alleen
# toevoegingen, de vorige versie werkt met het nieuwere schema). Database in
# SQLite: zoals vroeger een kopie in pre-update/ die bij terugvallen terugkomt.
#
# GHCR krijgt alleen images die de tests en smoketest in release.yml doorstaan.
set -euo pipefail

APP_DIR="/opt/apps/aquatech"
IMAGE="ghcr.io/danieldh00/aquatech"
KEEP_DB_COPIES=5

cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
wait_healthy() {
  local st=""
  for _ in $(seq 1 40); do
    st="$(docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true)"
    [[ "$st" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}

[[ -s secrets/master-key ]] || { log "Geen hoofdsleutel; overslaan."; exit 0; }

docker pull -q "$IMAGE:latest" >/dev/null
NEW_VER="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")"
CUR_VER="$(env_get AQUATECH_TAG)"
FAILED_VER="$(cat .failed-version 2>/dev/null || true)"

[[ -n "$NEW_VER" ]] || { log "Geen versielabel op $IMAGE:latest; overslaan."; exit 1; }
[[ "$NEW_VER" == "$CUR_VER" ]] && exit 0
[[ "$NEW_VER" == "$FAILED_VER" ]] && { log "Versie $NEW_VER faalde eerder; overslaan."; exit 0; }

# Alleen vooruit: een oudere :latest (bijv. na handmatig terugzetten) negeren.
if [[ -n "$CUR_VER" ]] && [[ "$(printf '%s\n%s\n' "$CUR_VER" "$NEW_VER" | sort -V | tail -n1)" != "$NEW_VER" ]]; then
  log "GHCR-versie $NEW_VER is ouder dan $CUR_VER; overslaan."
  exit 0
fi

log "Update ${CUR_VER:-geen} -> $NEW_VER"
docker pull -q "$IMAGE:$NEW_VER" >/dev/null

PG=0
grep -qE '^\s*- DATABASE_URL_FILE=' compose.yml && PG=1
if [[ "$PG" == 1 ]]; then
  # Terwijl de app nog draait (consistente momentopname); oudere versies
  # kennen 'create' nog niet, dan alleen een waarschuwing.
  docker compose exec -T -u 1000 aquatech node src/backup.js create \
    || log "Waarschuwing: geen back-up vóór de update (versie ${CUR_VER:-?} kent 'backup.js create' nog niet?)"
fi

mkdir -p pre-update
docker compose stop aquatech
if [[ "$PG" == 0 && -f data/aquatech.db ]]; then
  cp -a data/aquatech.db "pre-update/aquatech-${CUR_VER:-onbekend}-$(date +%Y%m%d%H%M).db"
  ls -1t pre-update/*.db 2>/dev/null | tail -n +$((KEEP_DB_COPIES + 1)) | xargs -r rm -f
fi

env_set AQUATECH_TAG "$NEW_VER"
docker compose up -d aquatech

if ! wait_healthy; then
  log "Niet healthy na update naar $NEW_VER; terug naar $CUR_VER"
  docker compose logs --tail 40 aquatech || true
  docker compose stop aquatech
  LAST="$(ls -1t pre-update/*.db 2>/dev/null | head -n1 || true)"
  if [[ "$PG" == 0 && -n "$LAST" ]]; then
    cp -a "$LAST" data/aquatech.db
    rm -f data/aquatech.db-wal data/aquatech.db-shm
    chown 1000:1000 data/aquatech.db
  fi
  env_set AQUATECH_TAG "$CUR_VER"
  docker compose up -d aquatech
  echo "$NEW_VER" > .failed-version
  exit 1
fi

rm -f .failed-version
docker image prune -f >/dev/null
log "Update naar $NEW_VER geslaagd"
