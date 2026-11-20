#!/usr/bin/env bash
# App-controle van de hersteltest van de Google Drive-back-up (Beheer > Systeem > Hersteltest Google Drive).
# Draait op apps01 als root, gestart door aquatech-restore-test-drive.path zodra de app een aanvraag klaarzet.
#
# De Drive-back-up kan alleen de app ophalen (OAuth), dus de app doet het ophalen, ontsleutelen en vergelijken zelf (platform/
# drive-restore-test.js) en zet daarna de gedownloade back-up klaar voor dit script:
#   update/request/drive-restore/request.json   {"id":"<uuid>","name":"aquatech-JJJJMMDD-UUMMSS.db.enc"} (dit script haalt het direct weg)
#   update/request/drive-restore/backup.db.enc  de back-up (de app maakt hem na afloop ook zelf weg; dit script ook)
#   update/status/drive-restore-app.json        {"id","state":"bezig|klaar|mislukt","finishedAt","message","sanity":[…]} (alleen dit script schrijft)
#
# Wat het doet: wegwerp-postgres op een intern netwerk zonder uitgang → de hele back-up erin zetten met een eenmalige container
# van hetzelfde image als de app (`node src/backup.js restore-into`, alleen met AQUATECH_RESTORE_TEST=1) → daarna dezelfde
# app-controle als de lokale hersteltest (restore-app-check.sh: wegwerp-app starten, inloggen als beheerder, kerngegevens
# ophalen) → alles opruimen. Het script vertrouwt de aanvraagmap niet (geen symlinks, vaste naamvorm, begrensde grootte).
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
PG_CONTAINER="${PG_CONTAINER:-aquatech-postgres}"
TEST_MEMORY="${TEST_MEMORY:-768m}"
APP_MEMORY="${APP_MEMORY:-512m}"
APP_WAIT_SEC="${APP_WAIT_SEC:-120}"
IMPORT_TIMEOUT_SEC="${IMPORT_TIMEOUT_SEC:-900}"
MAX_BACKUP_BYTES="${MAX_BACKUP_BYTES:-4294967296}"
KEY_FILE="$APP_DIR/secrets/master-key"
STATUS_DIR="$APP_DIR/update/status"
HANDOVER_DIR="$APP_DIR/update/request/drive-restore"
TEST_CONTAINER="aquatech-driverestore-$$"
IMPORT_CONTAINER="aquatech-driveimport-$$"
APP_CONTAINER="aquatech-driveapp-$$"
TEST_NETWORK="aquatech-drivenet-$$"
WORK_DIR=""
REQUEST_ID=""

# shellcheck source=restore-app-check.sh
source "$(dirname "${BASH_SOURCE[0]}")/restore-app-check.sh"

log() { echo "[$(date '+%F %T')] $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
json_text() { printf '%s' "$1" | tr -d '"\\' | tr '[:cntrl:]' ' ' | head -c 300; }
status_put() { # <inhoud>
  local tmp
  tmp="$(mktemp "$STATUS_DIR/.tmp.XXXXXX")"
  printf '%s\n' "$1" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATUS_DIR/drive-restore-app.json"
}
# Schrijft de uitslag voor de app.
publish() { # <state> <melding>
  status_put "$(printf '{"id":"%s","state":"%s","finishedAt":"%s","message":"%s","sanity":[%s]}' "$REQUEST_ID" "$1" "$([[ "$1" == bezig ]] && echo "" || now)" "$(json_text "$2")" "$SANITY")"
}
cleanup() {
  docker rm -f -v "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f -v "$IMPORT_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f -v "$TEST_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$TEST_NETWORK" >/dev/null 2>&1 || true
  rm -f "$HANDOVER_DIR/backup.db.enc" "$HANDOVER_DIR/request.json"
  [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$STATUS_DIR"
exec 9>"$STATUS_DIR/.restore-test-drive.lock"
flock -n 9 || { log "Er loopt al een app-controle van de Drive-back-up; overslaan."; exit 0; }

# ---------- De aanvraag lezen en controleren ----------
request="$HANDOVER_DIR/request.json"
[[ -f "$request" && ! -L "$request" ]] || exit 0
if (( $(stat -c %s "$request") > 4096 )); then rm -f "$request"; exit 0; fi
body="$(head -c 4096 "$request")"
rm -f "$request"
REQUEST_ID="$(grep -oE '"id"[[:space:]]*:[[:space:]]*"[0-9a-f-]{36}"' <<<"$body" | grep -oE '[0-9a-f-]{36}' | head -n1 || true)"
[[ -n "$REQUEST_ID" ]] || { log "Aanvraag zonder geldig id; genegeerd."; exit 0; }
SANITY=""; SANITY_FAILED=0; APP_NOTE=""
publish bezig "De app-controle van de Drive-back-up loopt."
log "App-controle van de Drive-back-up gestart"

BACKUP_FILE="$HANDOVER_DIR/backup.db.enc"
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || { publish mislukt "De back-up staat niet klaar op de server (geen gewoon bestand)."; exit 1; }
size="$(stat -c %s "$BACKUP_FILE")"
(( size > 0 && size <= MAX_BACKUP_BYTES )) || { publish mislukt "De back-up heeft een ongeldige grootte."; exit 1; }
[[ -s "$KEY_FILE" ]] || { publish mislukt "Geen hoofdsleutel; de back-up kan niet worden geopend."; exit 1; }
APP_IMAGE="$(docker inspect -f '{{.Config.Image}}' "${APP_PROD_CONTAINER:-aquatech}" 2>/dev/null || true)"
[[ -n "$APP_IMAGE" ]] || { publish mislukt "Het image van de draaiende app is niet te vinden; de app-controle kan niet starten."; exit 1; }
PG_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || echo postgres:17)"
WORK_DIR="$(mktemp -d)"

# ---------- Wegwerpdatabase op een intern netwerk ----------
docker network create --internal "$TEST_NETWORK" >/dev/null 2>"$WORK_DIR/net.err" \
  || { publish mislukt "Het wegwerpnetwerk kon niet worden gemaakt: $(head -c 150 "$WORK_DIR/net.err")"; exit 1; }
docker run -d --name "$TEST_CONTAINER" --memory "$TEST_MEMORY" --memory-swap "$TEST_MEMORY" --network "$TEST_NETWORK" --network-alias db --cpus 1 \
  -e POSTGRES_PASSWORD=wegwerp -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$PG_IMAGE" postgres -c shared_buffers=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=10 >/dev/null 2>"$WORK_DIR/run.err" \
  || { publish mislukt "De testdatabase kon niet starten: $(head -c 150 "$WORK_DIR/run.err")"; exit 1; }
ready=0
for _ in $(seq 1 60); do
  docker exec "$TEST_CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && { ready=1; break; }
  sleep 2
done
(( ready == 1 )) || { publish mislukt "De testdatabase werd niet gereed binnen 2 minuten."; exit 1; }

# ---------- De hele back-up terugzetten (eenmalige container met het image van de app) ----------
# De container migreert de lege database naar het schema van het image, leegt alle tabellen en leest de back-up in.
if ! timeout "$IMPORT_TIMEOUT_SEC" docker run --rm --name "$IMPORT_CONTAINER" --memory "$APP_MEMORY" --memory-swap "$APP_MEMORY" --cpus 1 \
    --network "$TEST_NETWORK" --read-only --tmpfs /tmp:rw,size=1g \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add DAC_OVERRIDE \
    -v "$KEY_FILE:/run/secrets/master-key:ro" -v "$BACKUP_FILE:/in/backup.db.enc:ro" \
    -e AQUATECH_MASTER_KEY_FILE=/run/secrets/master-key -e AQUATECH_RESTORE_TEST=1 -e DATA_DIR=/tmp \
    -e "DATABASE_URL=postgres://postgres@db:5432/postgres?sslmode=disable" \
    "$APP_IMAGE" node src/backup.js restore-into /in/backup.db.enc >"$WORK_DIR/import.out" 2>&1; then
  detail="$(tail -n 2 "$WORK_DIR/import.out" | tr '\n' ' ')"
  app_check "Drive-back-up teruggezet in een wegwerpdatabase" fail
  publish mislukt "Terugzetten van de Drive-back-up mislukte: $detail"
  exit 1
fi
app_check "Drive-back-up teruggezet in een wegwerpdatabase" ok

# ---------- De app zelf op de teruggezette gegevens ----------
run_app_check
if (( SANITY_FAILED > 0 )); then
  publish mislukt "$SANITY_FAILED controle(s) van de wegwerp-app gaven geen goed resultaat."
  exit 1
fi
publish klaar "${APP_NOTE:-De Drive-back-up is teruggezet; de app startte erop, logde in en haalde gegevens op.}"
log "App-controle van de Drive-back-up klaar"
