#!/usr/bin/env bash
# Update van Aquatech op apps01. Start op twee manieren (dezelfde systemd-service aquatech-update.service):
#   - de timer aquatech-update.timer, elke 15 minuten: kijkt welke versie :latest in GHCR heeft en installeert die
#     zelf als "automatisch bijwerken" aan staat (Beheer > Systeem > Updates; standaard aan);
#   - de path-unit aquatech-update.path, meteen zodra de app een aanvraag neerzet (knop "Nu updaten").
#
# Koppeling met de app (zie beregeningsplanner/backend/src/platform/system-update.js):
#   update/status/   alleen dit script schrijft hier (root); in de container alleen-lezen.
#     status.json       draaiende en beschikbare versie, laatst gecontroleerd
#     run.json          stand van de laatste uitrol (bezig/geslaagd/mislukt/geweigerd, stap, melding)
#     releases.json     releasenotes van de beschikbare versie, uit het nieuwe image (tools/release-info.js)
#     maintenance.json  bestaat zolang de uitrol loopt: de app weigert dan schrijfverzoeken (onderhoudsmodus)
#   update/request/  de app (uid 1000) schrijft hier; dit script vertrouwt de inhoud niet.
#     request.json      "installeer versie X": alleen geldig als X precies de versie is die dit script uit GHCR haalde
#     policy.json       {"auto":false} zet automatisch bijwerken uit
#
# Uitrol: onderhoudsmodus aan → even wachten tot lopende verzoeken klaar zijn → back-up → container vervangen →
# wachten op healthy én de nieuwe versie op /api/health → onderhoudsmodus uit. Lukt dat niet, dan terug naar de vorige
# versie (SQLite: ook de databasekopie) en wordt die versie overgeslagen tot er een nieuwere is of iemand hem in de app
# opnieuw aanvraagt.
#
# Database in Supabase (DATABASE_URL_FILE in compose.yml): vooraf een versleutelde back-up in data/backups; bij
# terugvallen wordt alleen de image teruggezet (migraties zijn alleen toevoegingen). Database in SQLite: een kopie in
# pre-update/ die bij terugvallen terugkomt.
#
# GHCR krijgt alleen images die de tests en smoketest in release.yml doorstaan.
set -euo pipefail

# APP_DIR, DRAIN_SECONDS en HEALTH_TRIES zijn alleen voor de test (backend/test/update-script.test.js) te wijzigen.
APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
IMAGE="ghcr.io/danieldh00/aquatech"
KEEP_DB_COPIES=5
STATUS_DIR="$APP_DIR/update/status"
REQUEST_DIR="$APP_DIR/update/request"
DRAIN_SECONDS="${DRAIN_SECONDS:-10}"
HEALTH_TRIES="${HEALTH_TRIES:-40}"
VERSION_RE='^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'

cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

# Eén update tegelijk (timer, path-unit en handmatig starten delen deze service, maar voor de zekerheid).
exec 9>"$APP_DIR/.update.lock"
flock -n 9 || { log "Er loopt al een update; overslaan."; exit 0; }

mkdir -p "$STATUS_DIR" "$REQUEST_DIR"

# Schrijft een bestand in de statusmap in één keer (tijdelijk bestand + mv: de app leest nooit een half bestand, en
# mv vervangt een eventuele symlink zelf in plaats van zijn doel).
status_put() {
  local tmp
  tmp="$(mktemp "$STATUS_DIR/.tmp.XXXXXX")"
  printf '%s\n' "$2" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS_DIR/$1"
}

# Leest een klein bestand uit de aanvraagmap van de app: geen symlink, gewoon bestand, hoogstens 4 kB.
request_read() {
  local file="$REQUEST_DIR/$1"
  [[ -f "$file" && ! -L "$file" ]] || return 0
  (( $(stat -c %s "$file") <= 4096 )) || return 0
  head -c 4096 "$file"
}

# Stand van de uitrol naar run.json. Alleen vaste teksten, gecontroleerde versies en een UUID gaan erin.
RUN_STATE=""; RUN_STEP=""; RUN_MESSAGE=""; RUN_STARTED=""; RUN_FINISHED=""; RUN_VERSION=""; REQ_ID=""; AUTOMATIC=false
run_put() {
  RUN_STATE="$1"; RUN_STEP="$2"; RUN_MESSAGE="$3"
  [[ "$1" == "bezig" ]] && RUN_FINISHED="" || RUN_FINISHED="$(now)"
  status_put run.json "{\"state\":\"$RUN_STATE\",\"step\":\"$RUN_STEP\",\"version\":\"$RUN_VERSION\",\"requestId\":\"$REQ_ID\",\"automatic\":$AUTOMATIC,\"startedAt\":\"$RUN_STARTED\",\"finishedAt\":\"$RUN_FINISHED\",\"message\":\"$RUN_MESSAGE\"}"
}

# Altijd bij het stoppen: onderhoudsmodus uit, en een onderbroken uitrol als mislukt melden.
on_exit() {
  rm -f "$STATUS_DIR/maintenance.json"
  if [[ "$RUN_STATE" == "bezig" ]]; then run_put mislukt klaar "De update is onderbroken. Controleer de server."; fi
}
trap on_exit EXIT

wait_healthy() {
  local st=""
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    st="$(docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true)"
    [[ "$st" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}
# De container meldt zich met de verwachte versie op /api/health.
health_version_is() {
  docker exec aquatech node -e "fetch('http://127.0.0.1:3300/api/health').then((r)=>r.json()).then((j)=>process.exit(j.ok===true&&j.version===process.argv[1]?0:1)).catch(()=>process.exit(1))" "$1"
}

[[ -s secrets/master-key ]] || { log "Geen hoofdsleutel; overslaan."; exit 0; }

# ---------- Aanvraag uit de app (wordt altijd weggehaald, ook als hij ongeldig is) ----------
REQ_BODY="$(request_read request.json || true)"
REQ_PRESENT=0
if [[ -e "$REQUEST_DIR/request.json" || -L "$REQUEST_DIR/request.json" ]]; then REQ_PRESENT=1; rm -f "$REQUEST_DIR/request.json"; fi
REQ_VER="$(grep -oE '"version":"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}"' <<<"$REQ_BODY" | head -n1 | cut -d'"' -f4 || true)"
REQ_ID="$(grep -oE '"id":"[0-9a-f-]{36}"' <<<"$REQ_BODY" | head -n1 | cut -d'"' -f4 || true)"
AUTO=1
grep -qE '"auto"[[:space:]]*:[[:space:]]*false' <<<"$(request_read policy.json || true)" && AUTO=0
# Meteen laten zien dat de aanvraag binnen is (ophalen en de releasenotes kunnen even duren).
if [[ "$REQ_PRESENT" == 1 ]]; then
  RUN_STARTED="$(now)"; [[ "$REQ_VER" =~ $VERSION_RE ]] && RUN_VERSION="$REQ_VER"
  run_put bezig ophalen "Aanvraag ontvangen."
fi

# ---------- Wat staat er klaar? ----------
docker pull -q "$IMAGE:latest" >/dev/null
NEW_VER="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")"
CUR_VER="$(env_get AQUATECH_TAG)"
FAILED_VER="$(cat .failed-version 2>/dev/null || true)"
[[ "$NEW_VER" =~ $VERSION_RE ]] || { log "Geen (geldig) versielabel op $IMAGE:latest; overslaan."; exit 1; }
[[ "$CUR_VER" =~ $VERSION_RE ]] || CUR_VER=""

status_put status.json "{\"current\":\"$CUR_VER\",\"available\":\"$NEW_VER\",\"checkedAt\":\"$(now)\",\"auto\":$([[ $AUTO == 1 ]] && echo true || echo false)}"

# Releasenotes van de nieuwe versie, één keer per versie: uit het image zelf, zonder netwerk en als gewone gebruiker.
if [[ "$(cat "$STATUS_DIR/.releases-version" 2>/dev/null || true)" != "$NEW_VER|$CUR_VER" ]]; then
  NOTES="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges -u 1000 \
    --entrypoint node "$IMAGE:latest" tools/release-info.js "$CUR_VER" 2>/dev/null | head -c 262144 || true)"
  [[ "$NOTES" == "{"* ]] || NOTES="{\"version\":\"$NEW_VER\",\"releases\":[]}"
  status_put releases.json "$NOTES"
  printf '%s' "$NEW_VER|$CUR_VER" > "$STATUS_DIR/.releases-version"
fi

# ---------- Moet er geïnstalleerd worden? ----------
RUN_VERSION="$NEW_VER"
if [[ "$REQ_PRESENT" == 1 ]]; then
  if [[ -z "$REQ_VER" ]]; then run_put geweigerd klaar "De aanvraag was onleesbaar."; log "Onleesbare aanvraag genegeerd."; exit 0; fi
  if [[ "$REQ_VER" != "$NEW_VER" ]]; then
    RUN_VERSION="$REQ_VER"; run_put geweigerd klaar "Versie $REQ_VER staat niet (meer) klaar; beschikbaar is $NEW_VER."
    log "Aanvraag voor $REQ_VER geweigerd: beschikbaar is $NEW_VER"; exit 0
  fi
  if [[ -n "$CUR_VER" ]] && ! newer "$NEW_VER" "$CUR_VER"; then
    run_put geweigerd klaar "Versie $NEW_VER is niet nieuwer dan wat er draait ($CUR_VER)."; exit 0
  fi
  log "Update naar $NEW_VER aangevraagd vanuit de app"
else
  REQ_ID=""
  [[ "$AUTO" == 1 ]] || exit 0
  [[ "$NEW_VER" == "$CUR_VER" ]] && exit 0
  [[ "$NEW_VER" == "$FAILED_VER" ]] && { log "Versie $NEW_VER faalde eerder; overslaan."; exit 0; }
  # Alleen vooruit: een oudere :latest (bijv. na handmatig terugzetten) negeren.
  if [[ -n "$CUR_VER" ]] && ! newer "$NEW_VER" "$CUR_VER"; then
    log "GHCR-versie $NEW_VER is ouder dan $CUR_VER; overslaan."
    exit 0
  fi
  AUTOMATIC=true
  RUN_STARTED="$(now)"
fi

# ---------- Uitrol ----------
log "Update ${CUR_VER:-geen} -> $NEW_VER"
run_put bezig ophalen "Nieuwe versie ophalen."
docker pull -q "$IMAGE:$NEW_VER" >/dev/null

# Onderhoudsmodus aan; de app weigert vanaf nu schrijfverzoeken. Even wachten tot lopende verzoeken klaar zijn.
run_put bezig onderhoud "Onderhoudsmodus aan."
status_put maintenance.json "{\"since\":\"$(now)\",\"version\":\"$NEW_VER\"}"
sleep "$DRAIN_SECONDS"

PG=0
grep -qE '^\s*- DATABASE_URL_FILE=' compose.yml && PG=1
run_put bezig back-up "Back-up maken."
if [[ "$PG" == 1 ]]; then
  # Terwijl de app nog draait (consistente momentopname); oudere versies
  # kennen 'create' nog niet, dan alleen een waarschuwing.
  docker compose exec -T -u 1000 aquatech node src/backup.js create \
    || log "Waarschuwing: geen back-up vóór de update (versie ${CUR_VER:-?} kent 'backup.js create' nog niet?)"
fi

run_put bezig herstarten "Nieuwe versie starten."
mkdir -p pre-update
docker compose stop aquatech
if [[ "$PG" == 0 && -f data/aquatech.db ]]; then
  cp -a data/aquatech.db "pre-update/aquatech-${CUR_VER:-onbekend}-$(date +%Y%m%d%H%M).db"
  ls -1t pre-update/*.db 2>/dev/null | tail -n +$((KEEP_DB_COPIES + 1)) | xargs -r rm -f
fi

env_set AQUATECH_TAG "$NEW_VER"
docker compose up -d aquatech

run_put bezig controleren "Controleren of de nieuwe versie goed draait."
if ! wait_healthy || ! health_version_is "$NEW_VER"; then
  log "Niet healthy na update naar $NEW_VER; terug naar $CUR_VER"
  run_put bezig terugzetten "De nieuwe versie start niet goed; terug naar $CUR_VER."
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
  if wait_healthy; then
    run_put mislukt klaar "Versie $NEW_VER startte niet goed; $CUR_VER draait weer."
  else
    run_put mislukt klaar "Versie $NEW_VER startte niet goed en de vorige versie start ook niet. Controleer de server."
  fi
  status_put status.json "{\"current\":\"$CUR_VER\",\"available\":\"$NEW_VER\",\"checkedAt\":\"$(now)\",\"auto\":$([[ $AUTO == 1 ]] && echo true || echo false)}"
  exit 1
fi

rm -f .failed-version
status_put status.json "{\"current\":\"$NEW_VER\",\"available\":\"$NEW_VER\",\"checkedAt\":\"$(now)\",\"auto\":$([[ $AUTO == 1 ]] && echo true || echo false)}"
run_put geslaagd klaar "Versie $NEW_VER draait."
docker image prune -f >/dev/null
log "Update naar $NEW_VER geslaagd"
