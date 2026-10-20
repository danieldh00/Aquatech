#!/usr/bin/env bash
# Overstap van SQLite naar Supabase (PostgreSQL) op apps01, in één keer.
#
# Vanaf de Proxmox-host (pve):
#   ssh -t root@apps01 'curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/switch-to-supabase.sh -o /tmp/aquatech-supabase.sh && bash /tmp/aquatech-supabase.sh'
#
# Vraagt de host van de Supabase Session pooler en het databasewachtwoord
# (verborgen invoer, komt alleen in secrets/database-url), en dan:
#   1. controleert dat Aquatech 0.34.0 of nieuwer draait (anders eerst bijwerken);
#   2. test de verbinding vanuit de container;
#   3. schrijft secrets/database-url en zet DATABASE_URL_FILE in compose.yml;
#   4. stopt de app, kopieert alles één op één en controleert (migrate-to-postgres.js);
#   5. start de app op PostgreSQL en wacht tot hij healthy is.
# Mislukt een stap, dan gaat compose.yml terug en draait de app weer op SQLite.
# data/aquatech.db wordt nooit aangepast of verwijderd.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
MIN_VERSION="0.34.0"
PROJECT_REF="${SUPABASE_REF:-gnpksxpolexriztojmjc}"

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }

# ---------- 1. Versie ----------
running_version() { docker inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' aquatech 2>/dev/null || true; }
newer_or_equal() { [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]; }
ver="$(running_version)"
if [[ -z "$ver" ]] || ! newer_or_equal "$ver" "$MIN_VERSION"; then
  log "Draait ${ver:-onbekend}; eerst bijwerken naar $MIN_VERSION of nieuwer"
  bash ./update.sh || true
  ver="$(running_version)"
  newer_or_equal "$ver" "$MIN_VERSION" || die "Aquatech draait $ver; $MIN_VERSION is nodig (staat die al in GHCR?)."
fi
log "Aquatech $ver draait"
if grep -qE '^\s*- DATABASE_URL_FILE=' compose.yml; then
  die "compose.yml gebruikt al DATABASE_URL_FILE; de overstap is al gedaan."
fi

# ---------- 2. Gegevens van Supabase ----------
echo
echo "Supabase -> Connect -> Session pooler. Host is bijv. aws-0-eu-central-1.pooler.supabase.com"
read -r -p "Host van de Session pooler: " HOST </dev/tty
HOST="${HOST#*@}"; HOST="${HOST%%/*}"; HOST="${HOST%%:*}"
[[ "$HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "Ongeldige host."
if [[ "$HOST" == db.*.supabase.co ]]; then
  echo "Let op: dit is de Direct connection (alleen IPv6). Vanuit Docker werkt die meestal niet."
  DBUSER="postgres"
else
  DBUSER="postgres.${PROJECT_REF}"
fi
read -r -p "Gebruiker [$DBUSER]: " u </dev/tty; DBUSER="${u:-$DBUSER}"
read -r -s -p "Databasewachtwoord (onzichtbaar): " PW </dev/tty; echo
[[ -n "$PW" ]] || die "Geen wachtwoord."

# Wachtwoord URL-veilig maken (@, #, ! enz.).
urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in [a-zA-Z0-9._~-]) out+="$c" ;; *) out+="$(printf '%%%02X' "'$c")" ;; esac
  done
  printf '%s' "$out"
}
LC_ALL=C
URL="postgresql://${DBUSER}:$(urlencode "$PW")@${HOST}:5432/postgres"
unset PW

# ---------- 3. Verbinding testen vanuit de container ----------
log "Verbinding met $HOST:5432 testen vanuit de container"
docker compose run --rm --no-deps -T --entrypoint node aquatech -e "
  const s = require('net').connect({ host: process.argv[1], port: 5432, timeout: 8000 });
  s.on('connect', () => { console.log('bereikbaar'); process.exit(0); });
  s.on('timeout', () => { console.error('time-out'); process.exit(1); });
  s.on('error', (e) => { console.error(e.code || e.message); process.exit(1); });
" "$HOST" || die "$HOST:5432 is niet bereikbaar vanuit de container (Direct connection? Neem de Session pooler)."

# ---------- 4. Secret en compose.yml ----------
STAMP="$(date +%Y%m%d%H%M%S)"
cp -a compose.yml "compose.yml.voor-supabase-$STAMP"
restore() {
  log "Terugdraaien: compose.yml terug, app weer op SQLite"
  cp -a "compose.yml.voor-supabase-$STAMP" compose.yml
  docker compose up -d aquatech || true
}

mkdir -p secrets
( umask 077; printf '%s' "$URL" > secrets/database-url.tmp )
unset URL
mv secrets/database-url.tmp secrets/database-url
chown 1000:1000 secrets/database-url
chmod 400 secrets/database-url

# Regels toevoegen (of de uitgecommentarieerde versie uit de repo aanzetten).
command -v python3 >/dev/null || apt-get install -y -qq python3 >/dev/null
python3 - <<'PY'
import re
p = 'compose.yml'
s = open(p).read()
s = re.sub(r'^(\s*)# (- DATABASE_URL_FILE=/run/secrets/database-url)\s*$', r'\1\2', s, flags=re.M)
s = re.sub(r'^(\s*)# (- database-url)\s*$', r'\1\2', s, flags=re.M)
s = re.sub(r'^(\s*)# (database-url:)\s*\n(\s*)#\s+(file: \./secrets/database-url)\s*$', r'\1\2\n\3  \4', s, flags=re.M)
if '- DATABASE_URL_FILE=' not in s:
    s = re.sub(r'^(\s*)- AQUATECH_MASTER_KEY_FILE=.*$', lambda m: m.group(0) + '\n' + m.group(1) + '- DATABASE_URL_FILE=/run/secrets/database-url', s, count=1, flags=re.M)
if not re.search(r'^\s+- database-url\s*$', s, flags=re.M):
    s = re.sub(r'^(\s+)- master-key\s*$', lambda m: m.group(0) + '\n' + m.group(1) + '- database-url', s, count=1, flags=re.M)
if not re.search(r'^\s+database-url:\s*$', s, flags=re.M):
    s = re.sub(r'^(\s+)master-key:\s*\n(\s+)file: \./secrets/master-key\s*$',
               lambda m: m.group(0) + '\n' + m.group(1) + 'database-url:\n' + m.group(2) + 'file: ./secrets/database-url', s, count=1, flags=re.M)
open(p, 'w').write(s)
PY
if ! docker compose config -q 2>/dev/null || ! docker compose config | grep -q 'DATABASE_URL_FILE: /run/secrets/database-url'; then
  cp -a "compose.yml.voor-supabase-$STAMP" compose.yml
  die "compose.yml kon niet worden aangepast; niets veranderd."
fi
log "compose.yml aangepast (kopie: compose.yml.voor-supabase-$STAMP)"

# ---------- 5. Kopiëren en controleren ----------
log "App stoppen en alle gegevens kopiëren"
docker compose stop aquatech
cp -a data/aquatech.db "data/aquatech-voor-supabase-$STAMP.db"
if ! docker compose run --rm --no-deps -T aquatech node src/migrate-to-postgres.js; then
  restore
  die "Overstap mislukt (zie hierboven); de app draait weer op SQLite."
fi

# ---------- 6. Starten op PostgreSQL ----------
log "App starten op PostgreSQL"
docker compose up -d aquatech
for _ in $(seq 1 40); do
  st="$(docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true)"
  [[ "$st" == "healthy" ]] && break
  sleep 3
done
if [[ "${st:-}" != "healthy" ]] || ! docker compose logs aquatech 2>&1 | grep -q 'Database: PostgreSQL'; then
  docker compose logs --tail 30 aquatech || true
  restore
  die "App werd niet healthy op PostgreSQL; terug op SQLite."
fi
docker compose logs aquatech 2>&1 | grep 'Database:' | tail -n1
log "Klaar: Aquatech draait op Supabase. Terug naar SQLite kan met: cp compose.yml.voor-supabase-$STAMP compose.yml && docker compose up -d aquatech"
