#!/usr/bin/env bash
# Database van Aquatech van Supabase naar een eigen PostgreSQL-container naast de app (op apps01).
# Dit script draait IN de app-server (guest); je start het vanaf de Proxmox-host met pve/db-local.sh, dat de
# bestanden hierheen kopieert en dit script aanroept (zie deploy/apps01/README.md).
#
#   local-db.sh migrate    Supabase -> eigen PostgreSQL (app kort uit, controle per tabel, terugdraaien bij een fout)
#   local-db.sh rollback   terug naar Supabase, met de gegevens van na de overstap (--no-copy: alleen de instelling)
#   local-db.sh status     waar draait de database, groottes, back-ups
#   local-db.sh backup     nu een versleutelde back-up maken
#   local-db.sh restore <bestand>   een back-up terugzetten (app kort uit)
# Opties: --yes (geen vraag; de host-wrapper vraagt zelf om bevestiging).
#
# Geheimen: de Supabase-URL blijft in secrets/database-url; de nieuwe wachtwoorden worden hier gemaakt en komen
# alleen in secrets/ (uid 1000 / root, mode 400). Niets daarvan gaat over een opdrachtregel of naar een log.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_CONTAINER="aquatech-postgres"
POSTGRES_TAG="${POSTGRES_TAG:-17}"
# Hoe streng de verbinding met Supabase gecontroleerd wordt (verify-full = certificaat + hostnaam).
SUPABASE_SSLMODE="${SUPABASE_SSLMODE:-verify-full}"
OVERRIDE_FILE="compose.localdb.yml"
COMPOSE_VALUE="compose.yml:$OVERRIDE_FILE"
MIN_FREE_KB=$((2 * 1024 * 1024))
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }
now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1; }
env_set() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
env_unset() { sed -i "/^$1=/d" .env; }

# docker compose met expliciet gekozen bestanden (los van wat in .env staat).
dc_supabase() { COMPOSE_FILE="compose.yml" docker compose "$@"; }
dc_local() { COMPOSE_FILE="$COMPOSE_VALUE" docker compose "$@"; }
# Wat nu in .env staat (zoals update.sh en de timer het zien).
dc_now() { docker compose "$@"; }

on_local_db() { [[ "$(env_get COMPOSE_FILE)" == *"$OVERRIDE_FILE"* ]]; }
pg_health() { docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null || true; }
app_health() { docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true; }
wait_health() { # <container-functie> <seconden>
  local waited=0
  while (( waited < $2 )); do
    [[ "$($1)" == "healthy" ]] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}
# Psql in de eigen database (via de socket in de container; geen wachtwoord nodig). Eerste argument: rol.
local_psql() { local role="$1"; shift; docker exec -i "$PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 -U "$role" -d aquatech "$@"; }

# Eén bewerking tegelijk, ook niet tegelijk met update.sh (zelfde slot).
exec 9>"$APP_DIR/.update.lock"
flock -n 9 || die "Er loopt al een update of migratie; probeer het straks opnieuw."

# ---------- Tijdelijke map en opruimen ----------
TMP_DIR=""; ENV_FILE=""
APP_STOPPED=0; SWITCHED=0; ENV_BACKUP=""; FAILED_MESSAGE=""
cleanup_tmp() {
  [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
  docker exec "$PG_CONTAINER" rm -f /tmp/supabase-ca.crt /tmp/supabase-bundle.crt >/dev/null 2>&1 || true
  rm -f "$APP_DIR/update/status/maintenance.json"
}
make_tmp() { umask 077; TMP_DIR="$(mktemp -d "$APP_DIR/.localdb-tmp.XXXXXX")"; ENV_FILE="$TMP_DIR/supabase.env"; }

# ---------- Verbinding met Supabase (vanuit de postgres-container, met het wachtwoord uit secrets/) ----------
prepare_source() {
  command -v python3 >/dev/null || { apt-get install -y -qq python3 >/dev/null; }
  [[ -s secrets/database-url ]] || die "secrets/database-url ontbreekt (de Supabase-verbinding)."
  local sslmode="$SUPABASE_SSLMODE"
  if [[ -f "$SRC_DIR/supabase-root-2021.crt" ]]; then
    # Systeemcertificaten + de root-CA van Supabase (zoals de app zelf doet).
    docker cp "$SRC_DIR/supabase-root-2021.crt" "$PG_CONTAINER:/tmp/supabase-ca.crt" >/dev/null
    docker exec "$PG_CONTAINER" sh -c 'cat /etc/ssl/certs/ca-certificates.crt /tmp/supabase-ca.crt > /tmp/supabase-bundle.crt'
  else
    log "Waarschuwing: root-CA van Supabase niet meegekomen; verbinding met sslmode=require (versleuteld, certificaat niet gecontroleerd)."
    sslmode="require"
  fi
  python3 - secrets/database-url "$ENV_FILE" "$sslmode" <<'PY'
import sys
import urllib.parse as parse
url = open(sys.argv[1]).read().strip()
parts = parse.urlparse(url)
if parts.scheme not in ('postgres', 'postgresql') or not parts.hostname:
    sys.exit('secrets/database-url is geen geldige postgres://-URL')
values = {
    'PGHOST': parts.hostname,
    'PGPORT': str(parts.port or 5432),
    'PGUSER': parse.unquote(parts.username or ''),
    'PGPASSWORD': parse.unquote(parts.password or ''),
    'PGDATABASE': (parts.path or '/postgres').lstrip('/') or 'postgres',
    'PGSSLMODE': sys.argv[3],
    'PGSSLROOTCERT': '/tmp/supabase-bundle.crt',
    'PGCONNECT_TIMEOUT': '15',
    'PGAPPNAME': 'aquatech-migratie',
}
for key, value in values.items():
    if '\n' in value or '\r' in value:
        sys.exit('ongeldige waarde in secrets/database-url')
with open(sys.argv[2], 'w') as handle:
    handle.write(''.join(f'{key}={value}\n' for key, value in values.items()))
PY
}
# psql / pg_dump / pg_restore tegen Supabase (uit de postgres-container; env-file, dus geen wachtwoord in argumenten).
src_psql() { docker exec -i --env-file "$ENV_FILE" "$PG_CONTAINER" psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
src_tool() { local tool="$1"; shift; docker exec -i --env-file "$ENV_FILE" "$PG_CONTAINER" "$tool" "$@"; }

# Per tabel: aantal rijen en een som over de tekstweergave van alle rijen (zelfde waarde = zelfde inhoud).
# SKIP_HASH=1 slaat het controlegetal over (alleen aantallen), bijvoorbeeld bij een heel grote database.
fingerprint_sql() {
  local hash_expr="(xpath('/row/h/text()', query_to_xml(format('SELECT coalesce(sum(hashtextextended(t::text, 0)::numeric), 0) AS h FROM %I.%I t', schemaname, tablename), false, true, '')))[1]::text"
  [[ "${SKIP_HASH:-0}" == "1" ]] && hash_expr="'-'"
  cat <<SQL
SET statement_timeout TO 0; SET TimeZone TO 'UTC'; SET extra_float_digits TO 3; SET DateStyle TO 'ISO, YMD'; SET IntervalStyle TO 'iso_8601';
SELECT tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text, $hash_expr
FROM pg_tables WHERE schemaname = 'aquatech' ORDER BY tablename;
SELECT 'policies', count(*) FROM pg_policies WHERE schemaname = 'aquatech' UNION ALL
SELECT 'indexes', count(*) FROM pg_indexes WHERE schemaname = 'aquatech' UNION ALL
SELECT 'rls_tables', count(*) FROM pg_tables WHERE schemaname = 'aquatech' AND rowsecurity;
SQL
}
fingerprint() { # <bron|lokaal>
  if [[ "$1" == "bron" ]]; then fingerprint_sql | src_psql; else fingerprint_sql | local_psql aquatech; fi
}

# ---------- Bestanden installeren (compose-aanvulling, back-upscript, timer) ----------
install_files() {
  local stamp="$1" file
  for file in "$OVERRIDE_FILE:compose.localdb.yml" "pg-backup.sh:pg-backup.sh"; do
    local src="${file%%:*}" dst="${file##*:}"
    [[ -f "$SRC_DIR/$src" ]] || die "$SRC_DIR/$src ontbreekt."
    if [[ -f "$dst" ]] && ! cmp -s "$SRC_DIR/$src" "$dst"; then cp -a "$dst" "$dst.bak-$stamp"; fi
    install -m 0644 "$SRC_DIR/$src" "$dst"
  done
  chmod 0755 pg-backup.sh
  for file in aquatech-pg-backup.service aquatech-pg-backup.timer; do
    [[ -f "$SRC_DIR/$file" ]] || die "$SRC_DIR/$file ontbreekt."
    install -m 0644 "$SRC_DIR/$file" "$SYSTEMD_DIR/$file"
  done
  systemctl daemon-reload
}

# ---------- migrate ----------
cmd_migrate() {
  local stamp; stamp="$(date +%Y%m%d%H%M%S)"
  command -v docker >/dev/null || die "Docker niet gevonden."
  command -v openssl >/dev/null || die "openssl niet gevonden."
  command -v systemctl >/dev/null || die "systemd niet gevonden."
  [[ -f compose.yml ]] || die "compose.yml niet gevonden in $APP_DIR."
  grep -qE '^\s*- DATABASE_URL_FILE=' compose.yml || die "De app draait op SQLite; ga eerst naar Supabase (switch-to-supabase.sh)."
  on_local_db && die "De app draait al op de eigen PostgreSQL (COMPOSE_FILE in .env)."
  [[ -s secrets/master-key ]] || die "secrets/master-key ontbreekt."
  [[ "$(app_health)" == "healthy" ]] || die "De app is niet healthy; los dat eerst op."
  local free_kb; free_kb="$(df -Pk "$APP_DIR" | awk 'NR==2{print $4}')"
  (( free_kb >= MIN_FREE_KB )) || die "Minder dan 2 GB vrij op de schijf van $APP_DIR."

  make_tmp
  trap on_migrate_exit EXIT
  log "Bestanden installeren"
  install_files "$stamp"

  # Wachtwoorden: superuser van de database (alleen voor beheer, eerste start) en de app-rol.
  mkdir -p secrets pgdata
  if [[ ! -s secrets/postgres-password ]]; then ( umask 077; openssl rand -hex 32 > secrets/postgres-password ); fi
  chown root:root secrets/postgres-password; chmod 400 secrets/postgres-password
  local app_password; app_password="$(openssl rand -hex 32)"
  ( umask 077; printf 'postgresql://aquatech:%s@postgres:5432/aquatech?sslmode=disable' "$app_password" > secrets/database-url-local.tmp )
  mv -f secrets/database-url-local.tmp secrets/database-url-local
  chown 1000:1000 secrets/database-url-local; chmod 400 secrets/database-url-local

  log "PostgreSQL $POSTGRES_TAG starten"
  export POSTGRES_TAG
  dc_local pull -q postgres
  dc_local up -d postgres
  wait_health pg_health 180 || { dc_local logs --tail 30 postgres || true; die "De PostgreSQL-container werd niet healthy."; }

  log "Rollen en database inrichten"
  # Het wachtwoord gaat via stdin (hex, dus zonder quotes-problemen) en staat nergens in een argument of log.
  {
    cat <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aquatech') THEN CREATE ROLE aquatech LOGIN CREATEROLE; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aquatech_app') THEN CREATE ROLE aquatech_app NOLOGIN NOBYPASSRLS; END IF;
END \$\$;
ALTER ROLE aquatech PASSWORD '$app_password';
GRANT aquatech_app TO aquatech;
ALTER DATABASE aquatech OWNER TO aquatech;
REVOKE ALL ON DATABASE aquatech FROM PUBLIC;
GRANT CONNECT ON DATABASE aquatech TO aquatech;
SQL
  } | docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d aquatech >/dev/null
  unset app_password

  # De lokale database moet leeg zijn (of de rest van een eerder mislukte poging zijn).
  local existing; existing="$(local_psql postgres -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'aquatech'")"
  if [[ "$existing" != "0" ]]; then
    [[ -f .localdb-migrating ]] || die "De lokale database bevat al $existing tabellen in schema aquatech maar er is geen mislukte migratie; niets overschreven. (Bewust opnieuw beginnen: touch $APP_DIR/.localdb-migrating, en draai dit opnieuw; de bestaande lokale gegevens gaan dan verloren.)"
    log "Rest van een eerdere poging opruimen"
    local_psql postgres -c "DROP SCHEMA aquatech CASCADE" >/dev/null
  fi

  log "Verbinding met Supabase testen"
  prepare_source
  src_psql -c "SELECT 1" >/dev/null || die "Geen verbinding met Supabase (zie secrets/database-url; bij een certificaatfout: SUPABASE_SSLMODE=require proberen)."
  local remote_num local_num remote_tables source_size
  remote_num="$(src_psql -c "SHOW server_version_num")"
  local_num="$(local_psql postgres -c "SHOW server_version_num")"
  (( 10#${remote_num:0:2} <= 10#${local_num:0:2} )) || die "Supabase draait PostgreSQL ${remote_num:0:2}, lokaal is ${local_num:0:2}. Zet POSTGRES_TAG=${remote_num:0:2} en gebruik een lege pgdata (nieuwe hoofdversie)."
  remote_tables="$(src_psql -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'aquatech'")"
  [[ "$remote_tables" -gt 0 ]] || die "Geen schema 'aquatech' (of geen tabellen) in Supabase."
  source_size="$(src_psql -c "SELECT pg_size_pretty(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass))) FROM pg_tables WHERE schemaname = 'aquatech'")"
  log "Supabase: PostgreSQL ${remote_num:0:2}, $remote_tables tabellen, ca. $source_size"

  log "Back-up van de app zelf (nog op Supabase)"
  dc_supabase exec -T -u 1000 aquatech node src/backup.js create || log "Waarschuwing: app-back-up mislukt; de dump hieronder is de back-up."

  # Vanaf hier mag er niets meer naar Supabase geschreven worden.
  touch .localdb-migrating
  log "Onderhoudsmodus aan en app stoppen"
  mkdir -p update/status
  printf '{"since":"%s","version":""}\n' "$(now)" > update/status/maintenance.json
  sleep 10
  APP_STOPPED=1
  dc_supabase stop aquatech

  log "Gegevens ophalen uit Supabase (pg_dump)"
  local dump="$TMP_DIR/supabase.dump"
  src_tool pg_dump -Fc -n aquatech --no-owner --no-acl > "$dump"
  [[ -s "$dump" ]] || die "De dump is leeg."
  docker exec -i "$PG_CONTAINER" pg_restore -l < "$dump" | grep ' TABLE ' >/dev/null || die "De dump bevat geen tabellen."
  log "Dump klaar ($(du -h "$dump" | cut -f1))"

  log "Terugzetten in de eigen database (pg_restore, alles of niets)"
  docker exec -i "$PG_CONTAINER" pg_restore -U aquatech -d aquatech --no-owner --no-acl --single-transaction --exit-on-error < "$dump" \
    || die "pg_restore mislukte; Supabase is onaangeroerd."

  log "Controleren: aantallen en inhoud per tabel, Supabase tegen lokaal"
  local source_print="$TMP_DIR/bron.txt" local_print="$TMP_DIR/lokaal.txt"
  fingerprint bron > "$source_print"
  fingerprint lokaal > "$local_print"
  if ! diff -q "$source_print" "$local_print" >/dev/null; then
    diff "$source_print" "$local_print" | head -n 30 >&2 || true
    die "De gegevens in de eigen database wijken af van Supabase (zie boven); niets omgezet."
  fi
  log "Gelijk: $(awk -F'|' 'NF==3 { tables += 1; rows += $2 } END { print tables " tabellen, " rows " rijen" }' "$local_print"); aantallen, inhoud (controlegetal) en structuur komen overeen."

  # Laatste momentopname van Supabase bewaren (versleuteld), voor het geval dat.
  mkdir -p backups/postgres; chmod 700 backups backups/postgres
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:secrets/master-key -in "$dump" -out "backups/postgres/supabase-laatste-$stamp.dump.enc"
  chmod 600 "backups/postgres/supabase-laatste-$stamp.dump.enc"

  log "App omzetten naar de eigen database"
  ENV_BACKUP=".env.voor-localdb-$stamp"
  cp -a .env "$ENV_BACKUP"
  env_set COMPOSE_FILE "$COMPOSE_VALUE"
  SWITCHED=1
  dc_now config --services | grep -qx postgres || die "docker compose ziet COMPOSE_FILE in .env niet; omgezet terug."
  dc_now up -d aquatech
  wait_health app_health 180 || { dc_now logs --tail 40 aquatech || true; die "De app werd niet healthy op de eigen database; terug naar Supabase."; }
  local logs; logs="$(dc_now logs --no-log-prefix aquatech 2>&1 || true)"
  grep -q 'Database: PostgreSQL' <<<"$logs" || die "De app meldt geen PostgreSQL; terug naar Supabase."
  ! grep -q 'Tenantafscherming in PostgreSQL niet actief' <<<"$logs" || die "De tenantafscherming (RLS) is niet actief op de eigen database; terug naar Supabase."
  local connections; connections="$(local_psql postgres -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'aquatech' AND usename = 'aquatech'")"
  [[ "$connections" -ge 1 ]] || die "De app verbindt niet met de eigen database; terug naar Supabase."
  [[ "$(local_psql postgres -c "SELECT pg_has_role('aquatech', 'aquatech_app', 'MEMBER')")" == "t" ]] || die "Rol aquatech mag aquatech_app niet aannemen (RLS); terug naar Supabase."

  log "Back-ups inschakelen"
  systemctl enable --now aquatech-pg-backup.timer >/dev/null
  bash ./pg-backup.sh || log "Waarschuwing: de eerste back-up mislukte; controleer met: journalctl -u aquatech-pg-backup.service"

  rm -f .localdb-migrating
  trap - EXIT
  cleanup_tmp
  log "Klaar: de app draait op de eigen PostgreSQL."
  cat <<MSG

Wat nu:
  - Test de app en de webshop (inloggen, een offerte of bestelling openen).
  - Supabase bevat een bevroren kopie van vóór de overstap en blijft ongewijzigd (secrets/database-url).
    Pauzeer of verwijder dat project pas na een paar weken zonder problemen.
  - Terug naar Supabase kan met:  db-local.sh rollback   (neemt de nieuwe gegevens mee)
  - Back-ups: dagelijks 02:30 in $APP_DIR/backups/postgres; kopieer die ook naar de Proxmox-host.
MSG
}

# Bij elke fout tijdens migrate: terug naar Supabase en de app weer starten (er is dan niets naar Supabase geschreven).
on_migrate_exit() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    echo "FOUT: migratie afgebroken (code $code). Terugdraaien naar Supabase..." >&2
    if (( SWITCHED )) && [[ -n "$ENV_BACKUP" && -f "$ENV_BACKUP" ]]; then cp -a "$ENV_BACKUP" .env; fi
    if (( APP_STOPPED )) || (( SWITCHED )); then
      COMPOSE_FILE="compose.yml" docker compose up -d aquatech || echo "Starten van de app lukte niet: controleer 'docker compose logs aquatech'." >&2
    fi
    echo "De app draait weer op Supabase (gegevens ongewijzigd). Opnieuw proberen kan: db-local.sh migrate" >&2
  fi
  cleanup_tmp
  exit "$code"
}

# ---------- rollback ----------
cmd_rollback() {
  local copy=1
  [[ "${1:-}" == "--no-copy" ]] && copy=0
  on_local_db || die "De app draait niet op de eigen PostgreSQL; niets terug te draaien."
  [[ "$(pg_health)" == "healthy" ]] || die "De eigen PostgreSQL draait niet (healthy)."
  local stamp; stamp="$(date +%Y%m%d%H%M%S)"
  make_tmp
  trap on_rollback_exit EXIT
  ENV_BACKUP=".env.voor-rollback-$stamp"
  if (( copy )); then
    log "Back-up van de eigen database vooraf"
    bash ./pg-backup.sh || die "Back-up vooraf mislukte; niets veranderd."
    prepare_source
    src_psql -c "SELECT 1" >/dev/null || die "Geen verbinding met Supabase; niets veranderd."
    log "Onderhoudsmodus aan en app stoppen"
    mkdir -p update/status
    printf '{"since":"%s","version":""}\n' "$(now)" > update/status/maintenance.json
    sleep 10
    dc_now stop aquatech
    log "Gegevens uit de eigen database ophalen"
    docker exec "$PG_CONTAINER" pg_dump -U postgres -d aquatech -n aquatech -Fc --no-owner --no-acl > "$TMP_DIR/lokaal.dump"
    [[ -s "$TMP_DIR/lokaal.dump" ]] || die "De dump is leeg; Supabase niet aangeraakt."
    log "Terugzetten in Supabase (vervangt schema aquatech, alles of niets)"
    src_tool pg_restore -d "$(sed -n 's/^PGDATABASE=//p' "$ENV_FILE")" --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error < "$TMP_DIR/lokaal.dump" \
      || { dc_now up -d aquatech || true; die "Terugzetten in Supabase mislukte (Supabase onveranderd, app weer op de eigen database)."; }
    log "Controleren: eigen database tegen Supabase"
    fingerprint lokaal > "$TMP_DIR/lokaal.txt"
    fingerprint bron > "$TMP_DIR/bron.txt"
    if ! diff -q "$TMP_DIR/lokaal.txt" "$TMP_DIR/bron.txt" >/dev/null; then
      diff "$TMP_DIR/lokaal.txt" "$TMP_DIR/bron.txt" | head -n 30 >&2 || true
      dc_now up -d aquatech || true
      die "Supabase wijkt na het terugzetten af; app is weer op de eigen database gestart. Niets omgezet."
    fi
  else
    log "Alleen de instelling terugzetten (zonder gegevens); wijzigingen van na de overstap blijven achter in de eigen database."
  fi
  cp -a .env "$ENV_BACKUP"
  env_unset COMPOSE_FILE
  dc_supabase up -d aquatech
  wait_health app_health 180 || { dc_supabase logs --tail 40 aquatech || true; die "De app werd niet healthy op Supabase."; }
  grep -q 'Database: PostgreSQL' <<<"$(dc_supabase logs --no-log-prefix aquatech 2>&1 || true)" || die "De app meldt geen PostgreSQL."
  trap - EXIT
  cleanup_tmp
  log "Klaar: de app draait weer op Supabase. De eigen PostgreSQL-container draait nog (data blijft in pgdata/);"
  log "stoppen kan met: COMPOSE_FILE=$COMPOSE_VALUE docker compose stop postgres"
}
on_rollback_exit() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    echo "FOUT: terugdraaien afgebroken (code $code)." >&2
    if [[ -f "$ENV_BACKUP" ]]; then cp -a "$ENV_BACKUP" .env; fi
    if [[ "$(app_health)" != "healthy" ]]; then dc_now up -d aquatech >/dev/null 2>&1 || true; fi
    echo "Controleer de stand met: db-local.sh status" >&2
  fi
  cleanup_tmp
  exit "$code"
}

# ---------- backup, restore, status ----------
cmd_backup() { on_local_db || die "De app draait niet op de eigen PostgreSQL."; bash ./pg-backup.sh; }

cmd_restore() {
  local file="${1:-}"
  on_local_db || die "De app draait niet op de eigen PostgreSQL."
  [[ -n "$file" ]] || die "Gebruik: restore <bestand>  (zie: db-local.sh status voor de lijst)."
  [[ "$file" == */* ]] || file="backups/postgres/$file"
  [[ -f "$file" && ! -L "$file" ]] || die "Back-upbestand niet gevonden: $file"
  [[ "$(pg_health)" == "healthy" ]] || die "De eigen PostgreSQL draait niet (healthy)."
  local decrypt="openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:secrets/master-key"
  $decrypt < "$file" | docker exec -i "$PG_CONTAINER" pg_restore -l | grep ' TABLE ' >/dev/null || die "Back-up niet te ontsleutelen of leeg (andere hoofdsleutel?)."
  log "Back-up van de huidige stand vooraf"
  bash ./pg-backup.sh || die "Back-up vooraf mislukte; niets veranderd."
  trap 'dc_now up -d aquatech >/dev/null 2>&1 || true; rm -f update/status/maintenance.json' EXIT
  mkdir -p update/status
  printf '{"since":"%s","version":""}\n' "$(now)" > update/status/maintenance.json
  sleep 10
  dc_now stop aquatech
  log "Terugzetten: $file"
  $decrypt < "$file" | docker exec -i "$PG_CONTAINER" pg_restore -U aquatech -d aquatech --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error \
    || die "Terugzetten mislukte (de database is ongewijzigd; de app wordt weer gestart)."
  dc_now up -d aquatech
  wait_health app_health 180 || die "De app werd niet healthy na het terugzetten."
  trap - EXIT
  rm -f update/status/maintenance.json
  log "Klaar: back-up teruggezet en app gestart."
}

cmd_status() {
  echo "Database van de app : $(on_local_db && echo 'eigen PostgreSQL (COMPOSE_FILE in .env)' || echo 'Supabase (compose.yml)')"
  echo "App                 : $(app_health || true)"
  echo "PostgreSQL-container: $(pg_health)  (image $(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER" 2>/dev/null || echo '-'))"
  if [[ "$(pg_health)" == "healthy" ]]; then
    echo "Omvang schema       : $(local_psql postgres -c "SELECT pg_size_pretty(coalesce(sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)), 0)) || ' in ' || count(*) || ' tabellen' FROM pg_tables WHERE schemaname = 'aquatech'" 2>/dev/null || echo '-')"
  fi
  echo "Schijf ($APP_DIR): $(df -Ph "$APP_DIR" | awk 'NR==2{print $4 " vrij van " $2}')"
  echo "Back-uptimer        : $(systemctl is-active aquatech-pg-backup.timer 2>/dev/null || true); volgende: $(systemctl show aquatech-pg-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || echo -)"
  echo "Laatste geslaagd    : $(cat backups/postgres/laatste-geslaagd 2>/dev/null || echo 'nog geen')"
  echo "Back-ups:"
  ls -lh --time-style=long-iso backups/postgres/*.enc 2>/dev/null | awk '{print "  " $6 " " $7 "  " $5 "  " $8}' || true
  [[ -f .localdb-migrating ]] && echo "LET OP: er is een mislukte migratie (.localdb-migrating); een nieuwe poging ruimt dat op." || true
}

# ---------- Aanroep ----------
command_name="${1:-}"; shift || true
args=(); for argument in "$@"; do [[ "$argument" == "--yes" ]] || args+=("$argument"); done
case "$command_name" in
  migrate)  cmd_migrate ;;
  rollback) cmd_rollback "${args[@]:-}" ;;
  backup)   cmd_backup ;;
  restore)  cmd_restore "${args[@]:-}" ;;
  status)   cmd_status ;;
  *) echo "Gebruik: local-db.sh migrate | rollback [--no-copy] | backup | restore <bestand> | status" >&2; exit 2 ;;
esac
