#!/usr/bin/env bash
# Versleutelde back-up van de eigen PostgreSQL-database van Aquatech (schema aquatech).
# Draait op de app-server (apps01), dagelijks via aquatech-pg-backup.timer; handmatig:
#   sudo systemctl start aquatech-pg-backup.service     (of: bash /opt/apps/aquatech/pg-backup.sh)
#
# - pg_dump (custom-formaat, gecomprimeerd) -> openssl AES-256-CBC (PBKDF2) met de hoofdsleutel van de app als
#   wachtwoord, naar backups/postgres/aquatech-<datum>-<tijd>.dump.enc (map en bestanden alleen voor root).
# - Elke back-up wordt direct gecontroleerd (ontsleutelen + inhoudsopgave lezen) voordat hij blijft staan.
# - Bewaartermijn: dagelijkse back-ups KEEP_DAILY_DAYS (14) dagen, die van zondag KEEP_WEEKLY_DAYS (56) dagen,
#   de nieuwste 3 altijd.
# - Terugzetten: db-local.sh restore <bestand> (vanaf de Proxmox-host), zie deploy/apps01/README.md.
# - Kopieer backups/postgres ook naar een andere plek (bijv. de Proxmox-host): back-ups op dezelfde schijf
#   beschermen niet tegen een kapotte schijf. Het bestand secrets/master-key is nodig om ze te openen.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
CONTAINER="${PG_CONTAINER:-aquatech-postgres}"
KEEP_DAILY_DAYS="${KEEP_DAILY_DAYS:-14}"
KEEP_WEEKLY_DAYS="${KEEP_WEEKLY_DAYS:-56}"
KEEP_NEWEST=3
BACKUP_DIR="$APP_DIR/backups/postgres"
KEY_FILE="$APP_DIR/secrets/master-key"

log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }

umask 077
[[ -s "$KEY_FILE" ]] || die "Geen hoofdsleutel ($KEY_FILE): back-up niet mogelijk."
mkdir -p "$BACKUP_DIR"
chmod 700 "$APP_DIR/backups" "$BACKUP_DIR" 2>/dev/null || true
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)" == "healthy" ]] \
  || die "Container $CONTAINER draait niet (healthy)."

# Eén back-up tegelijk.
exec 8>"$BACKUP_DIR/.lock"
flock -n 8 || { log "Er loopt al een back-up; overslaan."; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
FINAL="$BACKUP_DIR/aquatech-$STAMP.dump.enc"
TMP="$BACKUP_DIR/.bezig-$STAMP"
trap 'rm -f "$TMP"' EXIT

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE"; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY_FILE"; }

log "Back-up maken: $FINAL"
docker exec "$CONTAINER" pg_dump -U postgres -d aquatech -n aquatech -Fc --no-owner --no-acl | encrypt > "$TMP"
[[ -s "$TMP" ]] || die "Back-up is leeg."

# Controle: ontsleutelen en de inhoudsopgave van de dump lezen; er moeten tabellen in staan.
if ! decrypt < "$TMP" | docker exec -i "$CONTAINER" pg_restore -l | grep ' TABLE ' >/dev/null; then
  die "Back-up gecontroleerd en afgekeurd (niet te ontsleutelen of geen tabellen); niet bewaard."
fi
mv -f "$TMP" "$FINAL"
log "Back-up klaar ($(stat -c %s "$FINAL") bytes)"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$BACKUP_DIR/laatste-geslaagd"

# Opruimen: dagelijkse back-ups na KEEP_DAILY_DAYS, zondagen na KEEP_WEEKLY_DAYS; de nieuwste KEEP_NEWEST blijven.
now_epoch="$(date +%s)"
index=0
while IFS= read -r file; do
  index=$((index + 1))
  (( index > KEEP_NEWEST )) || continue
  name="$(basename "$file")"
  stamp="${name#aquatech-}"; stamp="${stamp%%.dump.enc}"
  [[ "$stamp" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})$ ]] || continue
  day="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
  made="$(date -d "$day ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s 2>/dev/null || echo "$now_epoch")"
  age_days=$(( (now_epoch - made) / 86400 ))
  limit="$KEEP_DAILY_DAYS"
  [[ "$(date -d "$day" +%u)" == "7" ]] && limit="$KEEP_WEEKLY_DAYS"
  if (( age_days > limit )); then
    rm -f -- "$file"
    log "Oude back-up verwijderd: $name"
  fi
done < <(ls -1t "$BACKUP_DIR"/aquatech-*.dump.enc 2>/dev/null)
log "Klaar"
