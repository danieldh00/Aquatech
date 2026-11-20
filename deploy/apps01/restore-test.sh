#!/usr/bin/env bash
# Hersteltest van de PostgreSQL-back-up (Beheer > Systeem > Back-ups > Hersteltest).
# Draait op apps01 als root, gestart door aquatech-restore-test.timer (elk half uur; het script bepaalt zelf of de
# ingestelde dag en tijd bereikt zijn) en aquatech-restore-test.path (knop "Nu testen" in de app).
#
# Wat het doet:
#   1. neemt de nieuwste versleutelde dump uit backups/postgres en ontsleutelt die als stroom (niets op schijf);
#   2. start een wegwerp-postgres-container (zelfde image als de productie, geheugenlimiet, geen netwerk, geen
#      vaste opslag) en zet de dump daarin terug;
#   3. controleert: tabellen aanwezig, schemaversie, rijtellingen tegen productie binnen een marge en een paar
#      sanity-queries (bestaan er organisaties en minstens één actieve beheerder);
#   4. start daarna een wegwerp-app-container (zelfde image als de productie, geheugenlimiet, alleen een intern
#      Docker-netwerk zonder uitgang: dus geen mail, koppelingen of andere verbindingen naar buiten) tegen de
#      teruggezette database en controleert dat de app start, de gegevens leest, inlogt als beheerder (met een
#      wegwerpwachtwoord dat alleen in de wegwerpdatabase staat) en een paar kerngegevens ophaalt;
#   5. ruimt alles altijd op (ook bij een fout) en schrijft de uitslag naar update/status/restore-test.json.
#
# Gegevens met de app (zelfde patroon als update.sh):
#   update/request/restore-test.json       {"enabled":true,"day":0,"time":"03:30"}  (de app schrijft, dit script vertrouwt niets)
#   update/request/restore-test-now.json   bestaat = nu testen (wordt altijd direct weggehaald)
#   update/status/restore-test.json        uitslag + historie (alleen dit script schrijft; in de container alleen-lezen)
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
PG_CONTAINER="${PG_CONTAINER:-aquatech-postgres}"
TEST_MEMORY="${TEST_MEMORY:-768m}"
APP_MEMORY="${APP_MEMORY:-512m}"
APP_WAIT_SEC="${APP_WAIT_SEC:-120}"
ROW_TOLERANCE_PCT="${ROW_TOLERANCE_PCT:-25}"
ROW_TOLERANCE_MIN="${ROW_TOLERANCE_MIN:-20}"
HISTORY_KEEP=12
BACKUP_DIR="$APP_DIR/backups/postgres"
KEY_FILE="$APP_DIR/secrets/master-key"
STATUS_DIR="$APP_DIR/update/status"
REQUEST_DIR="$APP_DIR/update/request"
HISTORY_FILE="$STATUS_DIR/.restore-test-history"
LAST_FILE="$STATUS_DIR/.restore-test-last"
RETRY_FILE="$STATUS_DIR/.restore-test-retry"
RETRY_AFTER_SEC=10800
TEST_CONTAINER="aquatech-restoretest-$$"
APP_CONTAINER="aquatech-restoreapp-$$"
TEST_NETWORK="aquatech-restorenet-$$"
WORK_DIR=""

log() { echo "[$(date '+%F %T')] $*"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Maakt een tekst veilig voor in JSON: geen aanhalingstekens, backslashes of stuurtekens, hoogstens 300 tekens.
json_text() { printf '%s' "$1" | tr -d '"\\' | tr '[:cntrl:]' ' ' | head -c 300; }

# Schrijft een bestand in de statusmap in één keer (tijdelijk bestand + mv), zoals update.sh.
status_put() { # <naam> <inhoud>
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

cleanup() {
  # Alles behalve een afgeronde run (time-out, kill, onverwachte fout): over enkele uren opnieuw proberen.
  [[ "${FINISHED:-0}" == 1 ]] || { [[ -n "${STARTED_AT:-}" ]] && date +%s > "$RETRY_FILE"; }
  docker rm -f -v "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f -v "$TEST_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$TEST_NETWORK" >/dev/null 2>&1 || true
  [[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$STATUS_DIR" "$REQUEST_DIR"
# De aanvraag "nu testen" altijd direct weghalen (anders blijft de path-unit het script opnieuw starten).
NOW_REQUESTED=0
if [[ -e "$REQUEST_DIR/restore-test-now.json" || -L "$REQUEST_DIR/restore-test-now.json" ]]; then
  rm -f "$REQUEST_DIR/restore-test-now.json"
  NOW_REQUESTED=1
fi
exec 9>"$STATUS_DIR/.restore-test.lock"
flock -n 9 || { log "Er loopt al een hersteltest; overslaan."; exit 0; }

# ---------- Moet er nu getest worden? ----------
POLICY="$(request_read restore-test.json || true)"
ENABLED=1; DAY=0; TIME="03:30"
grep -qE '"enabled"[[:space:]]*:[[:space:]]*false' <<<"$POLICY" && ENABLED=0
day_found="$(grep -oE '"day"[[:space:]]*:[[:space:]]*[0-6]' <<<"$POLICY" | grep -oE '[0-6]$' || true)"
[[ -n "$day_found" ]] && DAY="$day_found"
time_found="$(grep -oE '"time"[[:space:]]*:[[:space:]]*"([01][0-9]|2[0-3]):[0-5][0-9]"' <<<"$POLICY" | grep -oE '[0-9]{2}:[0-9]{2}' || true)"
[[ -n "$time_found" ]] && TIME="$time_found"

TRIGGER="schema"
if (( NOW_REQUESTED == 1 )); then
  TRIGGER="handmatig"
else
  (( ENABLED == 1 )) || { log "Hersteltest staat uit."; exit 0; }
  # Het laatste moment waarop de test had moeten starten (dag en tijd); alleen testen als daarna nog niet getest is.
  slot_epoch=0
  for back in 0 1 2 3 4 5 6; do
    candidate="$(date -d "-$back days $TIME" +%s 2>/dev/null || echo 0)"
    [[ "$(date -d "@$candidate" +%w)" == "$DAY" ]] && (( candidate <= $(date +%s) )) && { slot_epoch="$candidate"; break; }
  done
  last_epoch="$(cat "$LAST_FILE" 2>/dev/null || echo 0)"
  [[ "$last_epoch" =~ ^[0-9]+$ ]] || last_epoch=0
  (( slot_epoch > 0 && slot_epoch > last_epoch )) || exit 0
  # Faalde de vorige poging vóór het terugzetten (geen back-up, productie niet gezond), dan pas na een paar uur opnieuw.
  retry_epoch="$(cat "$RETRY_FILE" 2>/dev/null || echo 0)"
  [[ "$retry_epoch" =~ ^[0-9]+$ ]] || retry_epoch=0
  (( $(date +%s) - retry_epoch >= RETRY_AFTER_SEC )) || exit 0
fi

# ---------- Uitslag bijhouden ----------
STARTED_AT="$(now)"; START_EPOCH="$(date +%s)"
PREPARED=0
STATE="mislukt"; MESSAGE=""; BACKUP_NAME=""; BACKUP_BYTES=0; BACKUP_AT=""
VERSION_BACKUP=0; VERSION_PROD=0; TABLES_BACKUP=0; TABLES_PROD=0; MISSING=""; DEVIATING=""; ROWS_CHECKED=0; SANITY=""

# Eén run als JSON-object.
run_json() { # <state> <finishedAt of leeg>
  local finished="${2:-}" duration=$(( $(date +%s) - START_EPOCH ))
  printf '{"state":"%s","trigger":"%s","startedAt":"%s","finishedAt":"%s","durationSec":%d,"backup":{"name":"%s","bytes":%d,"createdAt":"%s"},"schemaVersion":{"backup":%d,"production":%d},"tables":{"backup":%d,"production":%d,"missing":[%s]},"rows":{"checked":%d,"deviating":[%s]},"sanity":[%s],"message":"%s"}' \
    "$1" "$TRIGGER" "$STARTED_AT" "$finished" "$duration" "$(json_text "$BACKUP_NAME")" "$BACKUP_BYTES" "$BACKUP_AT" \
    "$VERSION_BACKUP" "$VERSION_PROD" "$TABLES_BACKUP" "$TABLES_PROD" "$MISSING" "$ROWS_CHECKED" "$DEVIATING" "$SANITY" "$(json_text "$MESSAGE")"
}

# Schrijft restore-test.json: de lopende of laatste run + de historie (nieuwste eerst).
publish() { # <run-json> <afgerond: 0|1>
  local history="" line
  if [[ -f "$HISTORY_FILE" ]]; then
    history="$(tail -n "$HISTORY_KEEP" "$HISTORY_FILE" | tac | paste -sd, -)"
  fi
  if [[ "$2" == "1" ]]; then
    printf '%s\n' "$1" >> "$HISTORY_FILE"
    tail -n "$HISTORY_KEEP" "$HISTORY_FILE" > "$HISTORY_FILE.new" && mv -f "$HISTORY_FILE.new" "$HISTORY_FILE"
    history="$(tac "$HISTORY_FILE" | paste -sd, -)"
    line="{\"running\":null,\"runs\":[$history],\"checkedAt\":\"$(now)\"}"
  else
    line="{\"running\":$1,\"runs\":[$history],\"checkedAt\":\"$(now)\"}"
  fi
  status_put restore-test.json "$line"
}

# Rondt af met een uitslag en stopt.
finish() { # <state> <melding>
  FINISHED=1
  STATE="$1"; MESSAGE="$2"
  # Alleen een run die tot het terugzetten kwam telt als gedaan; een mislukte voorbereiding wordt over enkele uren herhaald.
  if (( PREPARED == 1 )); then date +%s > "$LAST_FILE"; rm -f "$RETRY_FILE"; else date +%s > "$RETRY_FILE"; fi
  publish "$(run_json "$STATE" "$(now)")" 1
  log "Hersteltest: $STATE. $MESSAGE"
  [[ "$STATE" == "mislukt" ]] && exit 1
  exit 0
}

publish "$(run_json bezig "")" 0
log "Hersteltest gestart ($TRIGGER)"

# ---------- Voorbereiding ----------
[[ -s "$KEY_FILE" ]] || finish mislukt "Geen hoofdsleutel; de back-up kan niet worden geopend."
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || true)" == "healthy" ]] \
  || finish mislukt "De productie-database draait niet (healthy); vergelijken is niet mogelijk."

# Nieuwste dump; ontbreekt die, dan maakt pg-backup.sh er één (zelfde dagelijkse back-up) en zoeken we opnieuw.
newest_dump() { ls -1t "$BACKUP_DIR"/aquatech-*.dump.enc 2>/dev/null | head -n1 || true; }
BACKUP_FILE="$(newest_dump)"
if [[ -z "$BACKUP_FILE" ]]; then
  if [[ -f "$APP_DIR/pg-backup.sh" && ! -L "$APP_DIR/pg-backup.sh" ]]; then
    log "Geen dump gevonden; pg-backup.sh maakt er een"
    BACKUP_LOG="$(timeout 900 bash "$APP_DIR/pg-backup.sh" 2>&1 | tail -n 3 | tr '\n' ' ')" || true
    [[ -n "$BACKUP_LOG" ]] || BACKUP_LOG="geen uitvoer (mogelijk na 15 minuten afgebroken)"
    poll="${LOCK_POLL_SEC:-10}"; [[ "$poll" =~ ^[0-9]+$ && "$poll" -ge 1 ]] || poll=10
    BACKUP_FILE="$(newest_dump)"
    # Draait de dagelijkse back-up net (pg-backup.sh sloeg dan over): wacht hoogstens 5 minuten tot die klaar is.
    waited=0
    while [[ -z "$BACKUP_FILE" ]] && (( waited < 300 )) && ! flock -n "$BACKUP_DIR/.lock" true 2>/dev/null; do
      sleep "$poll"; waited=$((waited + poll)); BACKUP_FILE="$(newest_dump)"
    done
    [[ -n "$BACKUP_FILE" ]] || finish mislukt "Er was geen dump in backups/postgres en pg-backup.sh kon er geen maken: ${BACKUP_LOG}"
  elif [[ ! -d "$BACKUP_DIR" ]]; then
    finish mislukt "De map backups/postgres bestaat niet op de server; de dagelijkse PostgreSQL-back-up (aquatech-pg-backup.timer) is niet ingericht."
  else
    finish mislukt "De map backups/postgres bevat geen aquatech-*.dump.enc en pg-backup.sh ontbreekt; de dagelijkse PostgreSQL-back-up is niet ingericht."
  fi
fi
[[ -f "$BACKUP_FILE" && ! -L "$BACKUP_FILE" ]] || finish mislukt "De nieuwste back-up is geen gewoon bestand (symlink?)."
BACKUP_NAME="$(basename "$BACKUP_FILE")"
BACKUP_BYTES="$(stat -c %s "$BACKUP_FILE")"
BACKUP_AT="$(date -u -d "@$(stat -c %Y "$BACKUP_FILE")" +%Y-%m-%dT%H:%M:%SZ)"
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY_FILE" < "$BACKUP_FILE"; }

WORK_DIR="$(mktemp -d)"
IMAGE="$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || echo postgres:17)"

# Intern netwerk zonder uitgang (--internal): de wegwerpdatabase en de wegwerp-app praten alleen met elkaar.
docker network create --internal "$TEST_NETWORK" >/dev/null 2>"$WORK_DIR/net.err" \
  || finish mislukt "Het wegwerpnetwerk kon niet worden gemaakt: $(head -c 200 "$WORK_DIR/net.err")"
# Wegwerpdatabase: geheugenlimiet, alleen het interne netwerk, anonieme opslag die met de container verdwijnt (--rm -v).
docker run -d --name "$TEST_CONTAINER" --memory "$TEST_MEMORY" --memory-swap "$TEST_MEMORY" --network "$TEST_NETWORK" --network-alias db --cpus 1 \
  -e POSTGRES_PASSWORD=wegwerp -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" postgres -c shared_buffers=64MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=10 >/dev/null 2>"$WORK_DIR/run.err" \
  || finish mislukt "De testcontainer kon niet starten: $(head -c 200 "$WORK_DIR/run.err")"
ready=0
for _ in $(seq 1 60); do
  docker exec "$TEST_CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && { ready=1; break; }
  sleep 2
done
(( ready == 1 )) || finish mislukt "De testcontainer werd niet gereed binnen 2 minuten."
test_psql() { docker exec -i "$TEST_CONTAINER" psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
prod_psql() { docker exec -i "$PG_CONTAINER" psql -U postgres -d aquatech -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
# De dump verwijst naar de rollen van de app (RLS-beleid); die moeten bestaan, ze krijgen hier geen rechten of wachtwoord.
test_psql -c "CREATE ROLE aquatech_app NOLOGIN; CREATE ROLE aquatech NOLOGIN;" >/dev/null 2>&1 || true

# ---------- Terugzetten ----------
PREPARED=1
# pg_restore -l stopt na de inhoudsopgave (openssl krijgt dan een gesloten pijp en pipefail telt dat als fout), dus
# eerst het hele bestand ontsleutelen en daarna de uitvoer van pg_restore -l in een variabele opvangen.
decrypt >/dev/null 2>&1 || finish mislukt "De back-up is niet te ontsleutelen (andere hoofdsleutel?)."
contents="$( { decrypt 2>/dev/null || true; } | docker exec -i "$TEST_CONTAINER" pg_restore -l 2>"$WORK_DIR/list.err" || true )"
grep -q ' TABLE ' <<<"$contents" || finish mislukt "De back-up bevat geen tabellen."
decrypt | docker exec -i "$TEST_CONTAINER" pg_restore -U postgres -d postgres --no-owner --no-acl 2>"$WORK_DIR/restore.err" >/dev/null
errors="$(grep -c 'pg_restore: error' "$WORK_DIR/restore.err" || true)"
if (( errors > 0 )); then
  finish mislukt "Terugzetten gaf $errors fout(en): $(grep 'pg_restore: error' "$WORK_DIR/restore.err" | head -n2 | tr '\n' ' ')"
fi

# ---------- Controles ----------
SCHEMA_QUERY="SELECT table_name FROM information_schema.tables WHERE table_schema = 'aquatech' AND table_type = 'BASE TABLE' ORDER BY 1"
test_psql -c "$SCHEMA_QUERY" > "$WORK_DIR/tables.test" 2>/dev/null || finish mislukt "De tabellen van de teruggezette database konden niet worden gelezen."
prod_psql -c "$SCHEMA_QUERY" > "$WORK_DIR/tables.prod" 2>/dev/null || finish mislukt "De tabellen van de productie-database konden niet worden gelezen."
TABLES_BACKUP="$(wc -l < "$WORK_DIR/tables.test")"; TABLES_PROD="$(wc -l < "$WORK_DIR/tables.prod")"
# Tabellen die in productie bestaan maar niet in de back-up: dan is de back-up ouder dan een migratie (waarschuwing) of onvolledig.
missing_list="$(comm -13 "$WORK_DIR/tables.test" "$WORK_DIR/tables.prod" | head -n 10)"
[[ -n "$missing_list" ]] && MISSING="$(printf '"%s"\n' $(printf '%s\n' "$missing_list" | tr -cd 'a-z0-9_\n') | paste -sd, -)"
(( TABLES_BACKUP > 0 )) || finish mislukt "De teruggezette database heeft geen tabellen."

VERSION_BACKUP="$(test_psql -c "SELECT version FROM aquatech.schema_version" 2>/dev/null | head -n1 | tr -cd '0-9')"; VERSION_BACKUP="${VERSION_BACKUP:-0}"
VERSION_PROD="$(prod_psql -c "SELECT version FROM aquatech.schema_version" 2>/dev/null | head -n1 | tr -cd '0-9')"; VERSION_PROD="${VERSION_PROD:-0}"
(( VERSION_BACKUP > 0 )) || finish mislukt "De teruggezette database heeft geen schemaversie."
(( VERSION_BACKUP <= VERSION_PROD )) || finish mislukt "De back-up heeft een nieuwere schemaversie ($VERSION_BACKUP) dan productie ($VERSION_PROD)."

# Rijtellingen per tabel (exacte telling, alleen lezen).
COUNT_QUERY="SELECT table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM aquatech.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'aquatech' AND table_type = 'BASE TABLE' ORDER BY 1"
test_psql -c "$COUNT_QUERY" > "$WORK_DIR/counts.test" 2>/dev/null || finish mislukt "De rijtellingen van de teruggezette database konden niet worden gelezen."
prod_psql -c "$COUNT_QUERY" > "$WORK_DIR/counts.prod" 2>/dev/null || finish mislukt "De rijtellingen van productie konden niet worden gelezen."
deviating_count=0
while IFS='|' read -r table prod_rows; do
  [[ "$table" =~ ^[a-z0-9_]+$ && "$prod_rows" =~ ^[0-9]+$ ]] || continue
  test_rows="$(grep -m1 "^$table|" "$WORK_DIR/counts.test" | cut -d'|' -f2)"
  [[ "$test_rows" =~ ^[0-9]+$ ]] || continue
  ROWS_CHECKED=$((ROWS_CHECKED + 1))
  margin=$(( prod_rows * ROW_TOLERANCE_PCT / 100 )); (( margin < ROW_TOLERANCE_MIN )) && margin=$ROW_TOLERANCE_MIN
  # De back-up is ouder dan productie, dus normaal minder of gelijk; meer dan de marge erboven of eronder valt op.
  if (( test_rows + margin < prod_rows || test_rows > prod_rows + margin )); then
    deviating_count=$((deviating_count + 1))
    (( deviating_count <= 10 )) && DEVIATING+="${DEVIATING:+,}{\"table\":\"$table\",\"backup\":$test_rows,\"production\":$prod_rows}"
  fi
done < "$WORK_DIR/counts.prod"

# Sanity-queries: de naam, het resultaat en of dat in orde is.
SANITY_FAILED=0
sanity() { # <naam> <query> (moet een getal > 0 geven)
  local value
  value="$(test_psql -c "$2" 2>/dev/null | head -n1 | tr -cd '0-9')"
  if [[ -n "$value" ]] && (( value > 0 )); then
    SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":$value,\"ok\":true}"
  else
    SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":${value:-0},\"ok\":false}"
    SANITY_FAILED=$((SANITY_FAILED + 1))
  fi
}
sanity "Organisaties aanwezig" "SELECT count(*) FROM aquatech.tenants"
sanity "Actieve beheerder met eigen account" "SELECT count(*) FROM aquatech.users WHERE role = 'beheerder' AND kind = 'account' AND disabled = 0 AND password_hash IS NOT NULL"
sanity "Schemaversie vastgelegd" "SELECT count(*) FROM aquatech.schema_version"

# ---------- De app zelf op de teruggezette gegevens ----------
# Zelfde image als de draaiende app, hoogstens APP_MEMORY, alleen het interne netwerk (geen mail, koppelingen of
# synchronisaties naar buiten), alleen-lezen bestandssysteem, wegwerp-datamap, CAPTCHA_DISABLED zodat inloggen niet
# naar Google hoeft. De hoofdsleutel gaat alleen-lezen mee: de back-up bevat versleutelde instellingen.
APP_NOTE=""
APP_IMAGE="$(docker inspect -f '{{.Config.Image}}' "${APP_PROD_CONTAINER:-aquatech}" 2>/dev/null || true)"
app_check() { # <naam> <ok|fail> <waarde> (zelfde lijst als de sanity-controles)
  if [[ "$2" == ok ]]; then SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":1,\"ok\":true}"
  else SANITY+="${SANITY:+,}{\"name\":\"$1\",\"value\":0,\"ok\":false}"; SANITY_FAILED=$((SANITY_FAILED + 1)); fi
}
if [[ -z "$APP_IMAGE" ]]; then
  APP_NOTE="De app-controle is overgeslagen (het image van de draaiende app is niet te vinden). "
elif ! docker run -d --name "$APP_CONTAINER" --memory "$APP_MEMORY" --memory-swap "$APP_MEMORY" --cpus 1 \
    --network "$TEST_NETWORK" --read-only --tmpfs /tmp --tmpfs /data \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add SETUID --cap-add SETGID \
    -v "$KEY_FILE:/run/secrets/master-key:ro" \
    -e PORT=3300 -e DATA_DIR=/data -e RUN_AS_ROOT=1 -e CAPTCHA_DISABLED=1 -e AQUATECH_MASTER_KEY_FILE=/run/secrets/master-key \
    -e "DATABASE_URL=postgres://postgres@db:5432/postgres?sslmode=disable" \
    "$APP_IMAGE" >/dev/null 2>"$WORK_DIR/app.err"; then
  app_check "App-container gestart" fail
  APP_NOTE="De wegwerp-app kon niet starten: $(head -c 150 "$WORK_DIR/app.err" | tr '\n' ' '). "
else
  app_ready=0
  for _ in $(seq 1 $(( APP_WAIT_SEC / 2 ))); do
    docker exec "$APP_CONTAINER" node -e "fetch('http://127.0.0.1:3300/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && { app_ready=1; break; }
    [[ "$(docker inspect -f '{{.State.Running}}' "$APP_CONTAINER" 2>/dev/null || echo false)" == true ]] || break
    sleep 2
  done
  if (( app_ready == 0 )); then
    app_check "App start op de teruggezette database" fail
    APP_NOTE="De app startte niet op de teruggezette database: $(docker logs --tail 3 "$APP_CONTAINER" 2>&1 | tr -cd '[:print:]\n' | tr '\n' ' ' | head -c 200). "
  else
    app_check "App start op de teruggezette database" ok
    # Het controlescript draait in de wegwerp-app: het zet in de wegwerpdatabase een wegwerpwachtwoord op een actieve
    # beheerder, logt in via de echte inlogroute en haalt een paar kerngegevens op. Uitvoer: ok|naam of fail|naam.
    script_failed=0; script_finished=0
    while IFS='|' read -r verdict name; do
      [[ "$verdict" == ok || "$verdict" == fail ]] || continue
      [[ "$verdict" == fail ]] && script_failed=1
      [[ "$verdict" == ok && "$name" == "Gebruikers ophalen" ]] && script_finished=1
      app_check "$(printf '%s' "$name" | tr -cd 'A-Za-z0-9 ,.()-')" "$verdict"
    done < <(timeout 120 docker exec -i "$APP_CONTAINER" node - 2>/dev/null <<'NODESCRIPT'
const crypto = require('crypto');
const { Client } = require('pg');
const { hashPassword } = require('./src/platform/password-hash');
const base = 'http://127.0.0.1:3300/app';
const say = (ok, name) => console.log(`${ok ? 'ok' : 'fail'}|${name}`);
async function getJson(path, cookie) {
  const response = await fetch(base + path, { headers: cookie ? { cookie } : {} });
  if (!response.ok) return null;
  try { return await response.json(); } catch (error) { return null; }
}
async function main() {
  const status = await getJson('/api/auth/status');
  say(Boolean(status) && status.setupRequired === false, 'App leest de teruggezette gegevens (geen eerste start)');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const found = await client.query("SELECT id, username FROM aquatech.users WHERE role = 'beheerder' AND kind = 'account' AND disabled = 0 AND password_hash IS NOT NULL ORDER BY platform_admin DESC, username LIMIT 1");
  if (!found.rows.length) { say(false, 'Inloggen als beheerder'); await client.end(); return; }
  const password = `Hersteltest-${crypto.randomBytes(9).toString('hex')}!`;
  await client.query('UPDATE aquatech.users SET password_hash = $1, totp_secret = NULL, must_change_password = 0 WHERE id = $2', [await hashPassword(password), found.rows[0].id]);
  await client.end();
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: found.rows[0].username, password }) });
  say(login.ok, 'Inloggen als beheerder op de teruggezette gegevens');
  if (!login.ok) return;
  const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
  say(Boolean(await getJson('/api/me', cookie)), 'Eigen account ophalen');
  say(Boolean(await getJson('/api/plans', cookie)), 'Tuinplannen ophalen');
  say(Boolean(await getJson('/api/quotes', cookie)), 'Offertes ophalen');
  say(Boolean(await getJson('/api/admin/users', cookie)), 'Gebruikers ophalen');
}
main().catch((error) => { say(false, 'Controle van de app voltooid'); });
NODESCRIPT
)
    # Geen uitvoer (require mislukt, time-out, docker exec zelf mislukt) mag nooit als geslaagd tellen: de laatste controle
    # van het script moet gelopen hebben, of er moet al een mislukte regel zijn.
    (( script_failed == 1 || script_finished == 1 )) || app_check "Controlescript van de app voltooid" fail
  fi
fi

# ---------- Uitslag ----------
if (( SANITY_FAILED > 0 )); then
  finish mislukt "$SANITY_FAILED sanity-controle(s) gaven geen goed resultaat."
fi
notes="$APP_NOTE"
(( VERSION_BACKUP < VERSION_PROD )) && notes+="De back-up is van een oudere schemaversie ($VERSION_BACKUP, productie $VERSION_PROD). "
[[ -n "$MISSING" ]] && notes+="Tabellen die in productie wel bestaan en in de back-up niet. "
(( deviating_count > 0 )) && notes+="$deviating_count tabel(len) met een afwijkend aantal rijen. "
if [[ -n "$notes" ]]; then
  finish waarschuwing "Teruggezet, maar: $notes"
fi
finish geslaagd "Back-up $BACKUP_NAME teruggezet: $TABLES_BACKUP tabellen, $ROWS_CHECKED rijtellingen vergeleken, schemaversie $VERSION_BACKUP; de app startte erop, logde in en haalde gegevens op."
