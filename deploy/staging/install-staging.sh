#!/usr/bin/env bash
# Stagingomgeving van Aquatech Hub op apps01: richt een tweede, aparte opstelling in naast de testomgeving én werkt hem bij.
# Veilig herhaalbaar; draait als root (start zichzelf anders met sudo). Zie docs/STAGING.md.
#
#   install-staging.sh           inrichten of bijwerken (handmatig: toont wat er gebeurt en wat je nog zelf moet doen)
#   install-staging.sh --timer   zoals hierboven, maar stil als er niets te doen is (de systemd-timer, elke 15 minuten)
#
# Wat het doet: eigen map (STAGING_DIR) met een eigen clone van de repo die origin/develop volgt (origin/master zolang
# develop niet bestaat), eigen geheimen, database en image (op de server gebouwd, label nl.aquatech.staging=1). Van de
# testomgeving wordt alleen de naam van de tunnelcontainer en van zijn netwerk gelezen (docker inspect, alleen-lezen).
# Geen koppelingen: geen mail, geen back-up naar buiten, geen betalingen. Geheimen worden nooit afgedrukt.
set -euo pipefail

STAGING_DIR="${STAGING_DIR:-/opt/apps/aquatech-staging}"
REPO_URL="${STAGING_REPO_URL:-https://github.com/danieldh00/Aquatech.git}"
TUNNEL_CONTAINER_DEFAULT="${TUNNEL_CONTAINER_DEFAULT:-aquatech-cloudflared}"
MIN_FREE_KB="${STAGING_MIN_FREE_KB:-$((6 * 1024 * 1024))}"
HEALTH_WAIT="${STAGING_HEALTH_WAIT:-180}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
APP_CONTAINER="aquatech-staging"
APP_SERVICE="aquatech-staging-app"
DB_SERVICE="aquatech-staging-db"
DB_CONTAINER="aquatech-staging-postgres"
IMAGE_LABEL="nl.aquatech.staging=1"
HOSTNAME_PUBLIC="${STAGING_HOSTNAME:-aquatech-staging.den-hollander.com}"
ALIAS="aquatech-staging"

TIMER=0
for argument in "$@"; do
  case "$argument" in
    --timer) TIMER=1 ;;
    -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "FOUT: onbekende optie $argument" >&2; exit 2 ;;
  esac
done

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
log() { echo "[$(date '+%F %T')] $*"; }
quiet() { [[ "$TIMER" == "1" ]] || log "$@"; }
die() { echo "FOUT: $*" >&2; exit 1; }

for tool in docker git curl openssl flock df; do command -v "$tool" >/dev/null || die "$tool niet gevonden."; done

mkdir -p "$STAGING_DIR"
chmod 755 "$STAGING_DIR"
cd "$STAGING_DIR"
# Eén run tegelijk (timer en handmatig).
exec 9>"$STAGING_DIR/.lock"
if ! flock -n 9; then
  [[ "$TIMER" == "1" ]] && { log "Er loopt al een run; overgeslagen."; exit 0; }
  die "Er loopt al een run; probeer het straks opnieuw."
fi

mkdir -p state secrets data pgdata
STATE_DEPLOYED="state/deployed"
STATE_SKIPPED="state/skipped"
FIRST_INSTALL=0
[[ -f .env ]] || FIRST_INSTALL=1

dc() { docker compose --project-directory "$STAGING_DIR" -f repo/deploy/staging/compose.yml --env-file "$STAGING_DIR/.env" "$@"; }
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1 || true; }
# Schrijft een waarde in .env (tijdelijk bestand + mv, mode 600; een ontbrekend slotregeleinde plakt niets aan elkaar).
env_set() { # <sleutel> <waarde>
  local tmp; tmp="$(umask 077; mktemp "$STAGING_DIR/.env.XXXXXX")"
  { grep -v "^$1=" .env 2>/dev/null || true; echo "$1=$2"; } > "$tmp"
  mv -f "$tmp" .env; chmod 600 .env
}
health_of() { docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || true; }
# Ruimt een container op die nog onder de oude servicenaam draait (`aquatech` of `postgres`): die servicenaam was ook een
# netwerkalias in het gedeelde tunnelnetwerk en botste met de testomgeving. Data staat in mappen op de host, dus niets gaat
# verloren; de container wordt daarna onder de nieuwe servicenaam opnieuw aangemaakt.
service_of() { docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$1" 2>/dev/null || true; }
retire_old_service() { # <container> <verwachte service>
  local service
  service="$(service_of "$1")"
  [[ -z "$service" || "$service" == "$2" ]] && return 0
  log "Oude servicenaam '$service' van $1 opruimen (wordt '$2')."
  docker stop -t 60 "$1" >/dev/null 2>&1 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
}
wait_healthy() { # <container> <seconden>
  local waited=0
  while (( waited < $2 )); do
    [[ "$(health_of "$1")" == "healthy" ]] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}
secret_file() { # <naam> <waarde>: schrijft alleen als het bestand nog niet bestaat (mode 400, root)
  [[ -s "secrets/$1" ]] && return 0
  ( umask 077; printf '%s' "$2" > "secrets/$1.tmp" )
  mv -f "secrets/$1.tmp" "secrets/$1"; chmod 400 "secrets/$1"
}

# ---------- 1. Schijfruimte (alleen de eerste installatie) ----------
if [[ "$FIRST_INSTALL" == "1" ]]; then
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
  free_kb="$(df -Pk "${docker_root:-/var/lib/docker}" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  [[ "$free_kb" =~ ^[0-9]+$ ]] || free_kb="$(df -Pk "$STAGING_DIR" | awk 'NR==2 {print $4}' || true)"
  if (( free_kb < MIN_FREE_KB )); then
    die "Te weinig vrije ruimte op de Docker-schijf ($((free_kb / 1024)) MB; nodig: $((MIN_FREE_KB / 1024)) MB). Ruim eerst op met de bestaande opruimtaak (servertaken.sh schijf) en draai dit opnieuw."
  fi
fi

# ---------- 2. Eigen clone: volgt origin/develop, anders origin/master ----------
if [[ ! -d repo/.git ]]; then
  quiet "Repo klonen naar $STAGING_DIR/repo"
  rm -rf repo
  git clone --quiet --no-checkout "$REPO_URL" repo || die "Klonen van $REPO_URL mislukt."
fi
git -C repo fetch --quiet --prune origin || die "Ophalen van de repo mislukt."
BRANCH="develop"
git -C repo rev-parse --verify -q "refs/remotes/origin/develop" >/dev/null || BRANCH="master"
TARGET="$(git -C repo rev-parse "refs/remotes/origin/$BRANCH")"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || die "Geen geldige commit op origin/$BRANCH."
SHORT="${TARGET:0:12}"
DEPLOYED="$(cat "$STATE_DEPLOYED" 2>/dev/null || true)"
SKIPPED="$(cat "$STATE_SKIPPED" 2>/dev/null || true)"

# ---------- 3. Tunnelgegevens (alleen-lezen uit de testomgeving) ----------
TUNNEL_CONTAINER="$(env_get TUNNEL_CONTAINER)"
TUNNEL_NETWORK="$(env_get TUNNEL_NETWORK)"
if [[ -z "$TUNNEL_CONTAINER" || -z "$TUNNEL_NETWORK" ]]; then
  TUNNEL_CONTAINER="${TUNNEL_CONTAINER:-$TUNNEL_CONTAINER_DEFAULT}"
  docker inspect "$TUNNEL_CONTAINER" >/dev/null 2>&1 || die "Tunnelcontainer $TUNNEL_CONTAINER niet gevonden. Draait de tunnel van de testomgeving? (Zet anders TUNNEL_CONTAINER_DEFAULT.)"
  networks="$(docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}' "$TUNNEL_CONTAINER" | xargs)"
  [[ -n "$networks" && "$networks" != *" "* ]] || die "Tunnelcontainer $TUNNEL_CONTAINER zit in geen of meer dan één netwerk ($networks); zet TUNNEL_NETWORK in $STAGING_DIR/.env."
  TUNNEL_NETWORK="$networks"
fi
[[ "$TUNNEL_CONTAINER" =~ ^[A-Za-z0-9_.-]+$ && "$TUNNEL_NETWORK" =~ ^[A-Za-z0-9_.-]+$ ]] || die "Ongeldige naam van tunnelcontainer of -netwerk."

# Het IP-adres van de tunnelcontainer wordt bij elke run bepaald en gevalideerd; alleen dat adres is een vertrouwde proxy.
TUNNEL_IP="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$TUNNEL_NETWORK\"}}{{.IPAddress}}{{end}}" "$TUNNEL_CONTAINER" 2>/dev/null | tr -d '[:space:]' || true)"
valid_ipv4() {
  local ip="$1" part
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for part in ${ip//./ }; do (( 10#$part <= 255 )) || return 1; done
}
# Een draaiende app onder de oude servicenaam telt niet als klaar, ook niet op dezelfde commit (zie retire_old_service).
healthy_on_deployed() { [[ -n "$DEPLOYED" && "$DEPLOYED" == "$TARGET" && "$(health_of "$APP_CONTAINER")" == "healthy" && "$(service_of "$APP_CONTAINER")" != "aquatech" && "$(service_of "$APP_CONTAINER")" != "postgres" ]]; }
if ! valid_ipv4 "$TUNNEL_IP"; then
  if healthy_on_deployed; then
    log "Geen (geldig) IP van de tunnelcontainer $TUNNEL_CONTAINER; staging draait gezond op ${SHORT}, niets te doen."
    exit 0
  fi
  die "Geen geldig IP-adres van de tunnelcontainer $TUNNEL_CONTAINER in netwerk $TUNNEL_NETWORK (draait de tunnel?). Staging wordt niet gestart zonder vertrouwde proxy."
fi
PROXY_VALUE="$TUNNEL_IP/32"

# ---------- 4. Is er iets te doen? ----------
# Alleen de timer slaat een eerder mislukte commit over; een handmatige run (servertaak) probeert het opnieuw, bijvoorbeeld
# nadat het script of de omgeving is hersteld.
if [[ "$TIMER" == "1" && "$TARGET" == "$SKIPPED" && "$TARGET" != "$DEPLOYED" ]]; then
  log "Commit $SHORT (origin/$BRANCH) is eerder mislukt en wordt overgeslagen tot er een nieuwere is."
  exit 0
fi
if healthy_on_deployed && [[ "$(env_get TRUSTED_PROXIES)" == "$PROXY_VALUE" ]]; then
  quiet "Staging draait gezond op $SHORT (origin/$BRANCH), tunnel-IP ongewijzigd. Niets te doen."
  exit 0
fi

# ---------- 5. Eerste installatie: eigen geheimen en .env ----------
if [[ "$FIRST_INSTALL" == "1" ]]; then
  log "Eerste installatie in $STAGING_DIR"
  secret_file master-key "$(openssl rand -hex 32)"
  secret_file postgres-password "$(openssl rand -hex 32)"
  secret_file app-db-password "$(openssl rand -hex 32)"
  secret_file admin-password "Staging-$(openssl rand -hex 12)-Tuin1!"
  ( umask 077; : > .env )
  env_set TZ "Europe/Amsterdam"
  env_set STAGING_PORT "3310"
  env_set SETUP_CODE "$(openssl rand -hex 6 | tr 'a-f' 'A-F')"
  env_set ANTHROPIC_API_KEY ""
  env_set VUE_MODULES ""
fi
[[ -s secrets/postgres-password && -s secrets/app-db-password ]] || die "secrets/ is onvolledig; verwijder $STAGING_DIR/.env en secrets/ alleen als er nog geen staging-gegevens zijn, en draai opnieuw."
env_set TUNNEL_CONTAINER "$TUNNEL_CONTAINER"
env_set TUNNEL_NETWORK "$TUNNEL_NETWORK"
env_set TRUSTED_PROXIES "$PROXY_VALUE"
# De app-verbinding: de wachtwoorden zijn hex, dus veilig in een URL; het bestand is alleen voor de app (uid 1000).
# De host is de unieke containernaam van staging, nooit `postgres`: de app zit ook in het tunnelnetwerk, waar de database van
# de testomgeving die naam heeft (Docker-DNS zou dan afwisselend naar productie kunnen wijzen).
( umask 077; printf 'postgresql://aquatech:%s@%s:5432/aquatech?sslmode=disable' "$(cat secrets/app-db-password)" "$DB_CONTAINER" > secrets/database-url.tmp )
mv -f secrets/database-url.tmp secrets/database-url
chown 1000:1000 secrets/database-url secrets/master-key data 2>/dev/null || true
chmod 400 secrets/database-url
chown root:root secrets/postgres-password secrets/app-db-password secrets/admin-password 2>/dev/null || true
chmod 700 secrets; chmod 400 secrets/postgres-password secrets/app-db-password secrets/admin-password 2>/dev/null || true

# ---------- 6. Bouwen (op de server) ----------
log "Commit $SHORT van origin/$BRANCH uitrollen"
git -C repo checkout --quiet --force --detach "$TARGET"
git -C repo clean --quiet -fdx
[[ -f repo/deploy/staging/compose.yml ]] || die "repo/deploy/staging/compose.yml ontbreekt op $SHORT."
PREVIOUS="$DEPLOYED"
export STAGING_COMMIT="$SHORT"
env_set STAGING_COMMIT "$SHORT"
fail_commit() { # <melding>: markeert de commit als mislukt (overslaan tot er een nieuwere is)
  printf '%s' "$TARGET" > "$STATE_SKIPPED"
  if [[ -n "$PREVIOUS" ]]; then
    env_set STAGING_COMMIT "${PREVIOUS:0:12}"
    # Ook de bron in repo/ terug naar wat draait, zodat een handmatige build of up niet de mislukte commit pakt.
    git -C repo checkout --quiet --force --detach "$PREVIOUS" 2>/dev/null || true
  fi
  echo "FOUT: $1" >&2
}
if ! dc build --quiet "$APP_SERVICE"; then
  fail_commit "Het image van commit $SHORT bouwde niet; de draaiende staging blijft zoals hij was en deze commit wordt overgeslagen tot er een nieuwere is."
  exit 1
fi

# ---------- 7. Database starten en de app-rol zetten ----------
retire_old_service "$DB_CONTAINER" "$DB_SERVICE"
dc up -d --remove-orphans "$DB_SERVICE"
wait_healthy "$DB_CONTAINER" 180 || { dc logs --tail 20 "$DB_SERVICE" >&2 || true; die "De staging-database werd niet gezond."; }
# Het wachtwoord gaat via stdin (hex) en staat nergens in een argument of log.
{
  cat <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aquatech') THEN CREATE ROLE aquatech LOGIN CREATEROLE; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aquatech_app') THEN CREATE ROLE aquatech_app NOLOGIN NOBYPASSRLS; END IF;
END \$\$;
ALTER ROLE aquatech PASSWORD '$(cat secrets/app-db-password)';
GRANT aquatech_app TO aquatech;
ALTER DATABASE aquatech OWNER TO aquatech;
REVOKE ALL ON DATABASE aquatech FROM PUBLIC;
GRANT CONNECT ON DATABASE aquatech TO aquatech;
SQL
} | docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$DB_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d aquatech >/dev/null

# ---------- 8. App starten; bij een ongezonde start terug naar de vorige commit ----------
retire_old_service "$APP_CONTAINER" "$APP_SERVICE"
dc up -d --force-recreate --remove-orphans "$APP_SERVICE"
if ! wait_healthy "$APP_CONTAINER" "$HEALTH_WAIT"; then
  dc logs --tail 20 "$APP_SERVICE" >&2 || true
  fail_commit "Commit $SHORT startte niet gezond."
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$TARGET" ]]; then
    log "Terug naar de vorige commit ${PREVIOUS:0:12}"
    git -C repo checkout --quiet --force --detach "$PREVIOUS" 2>/dev/null || true
    export STAGING_COMMIT="${PREVIOUS:0:12}"
    if dc up -d --force-recreate "$APP_SERVICE" && wait_healthy "$APP_CONTAINER" "$HEALTH_WAIT"; then
      log "Vorige commit draait weer; $SHORT wordt overgeslagen tot er een nieuwere is."
    else
      echo "FOUT: ook de vorige commit startte niet gezond; kijk met 'docker logs $APP_CONTAINER'." >&2
    fi
  else
    dc stop "$APP_SERVICE" >/dev/null 2>&1 || true
  fi
  exit 1
fi
printf '%s' "$TARGET" > "$STATE_DEPLOYED"
rm -f "$STATE_SKIPPED"
log "Staging draait gezond op $SHORT (origin/$BRANCH)."

# ---------- 9. Verzonnen testdata in een lege database ----------
seed_testdata_run() {
  local base="http://127.0.0.1:$(env_get STAGING_PORT)/app/api" status code tenant_id env_id out
  [[ -f state/seeded ]] && return 0
  status="$(curl -fsS -m 20 "$base/setup" 2>/dev/null || true)"
  [[ "$status" == *'"required":true'* ]] || { : > state/seeded; return 0; }
  local json=(-H 'Content-Type: application/json')
  # Eerste beheerder met de gegenereerde installatiecode; wachtwoord uit secrets/admin-password (via stdin, niet in het log).
  printf '{"code":"%s","username":"beheer","displayName":"Staging-beheerder","password":"%s"}' "$(env_get SETUP_CODE)" "$(cat secrets/admin-password)" \
    | curl -fsS -m 60 -c "$jar" "${json[@]}" --data-binary @- "$base/setup" >/dev/null || { log "Testdata overgeslagen: de eerste beheerder aanmaken mislukte."; return 0; }
  out="$(curl -fsS -m 30 -b "$jar" "$base/platform/tenants" || true)"
  tenant_id="$(sed -n 's/.*"mainTenantId":"\([0-9a-f-]*\)".*/\1/p' <<<"$out")"
  [[ -n "$tenant_id" ]] || { log "Testdata overgeslagen: hoofdtenant niet gevonden."; return 0; }
  out="$(curl -fsS -m 60 -b "$jar" "${json[@]}" -d '{"name":"Staging testdata"}' "$base/platform/tenants/$tenant_id/environments" || true)"
  env_id="$(sed -n 's/.*"tenant":{"id":"\([0-9a-f-]*\)".*/\1/p' <<<"$out")"
  [[ -n "$env_id" ]] || { log "Testdata overgeslagen: testomgeving aanmaken mislukte."; return 0; }
  # Het gedeelde wachtwoord van de testaccounts staat alleen in dit antwoord: naar een bestand, nooit naar het log.
  code="$(curl -sS -m 300 -b "$jar" "${json[@]}" -d '{}' -o "$jar.out" -w '%{http_code}' "$base/platform/tenants/$env_id/testdata" || true)"
  if [[ "$code" == "201" ]]; then
    ( umask 077; sed -n 's/.*"password":"\([^"]*\)".*/\1/p' "$jar.out" > secrets/testdata-password )
    chmod 400 secrets/testdata-password
    : > state/seeded
    log "Verzonnen testdata gevuld (testomgeving 'Staging testdata')."
  else
    log "Testdata overgeslagen: vullen gaf status $code."
  fi
}
# De cookiejar en het antwoord staan alleen kort in een tijdelijk bestand (mode 600) en worden altijd verwijderd.
seed_testdata() {
  jar="$(umask 077; mktemp "$STAGING_DIR/.jar.XXXXXX")"
  seed_testdata_run || true
  rm -f "$jar" "$jar.out"
}
seed_testdata

# ---------- 10. Opruimen: alleen oude images met het eigen label ----------
keep_current="aquatech-staging:$SHORT"
keep_previous=""
[[ -n "$PREVIOUS" ]] && keep_previous="aquatech-staging:${PREVIOUS:0:12}"
for image in $(docker image ls --filter "label=$IMAGE_LABEL" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true); do
  [[ "$image" == aquatech-staging:* ]] || continue
  [[ "$image" == "$keep_current" || "$image" == "$keep_previous" ]] && continue
  docker image rm "$image" >/dev/null 2>&1 || true
done

# ---------- 11. Systemd: dit script elke 15 minuten ----------
INSTALLED="$STAGING_DIR/install-staging.sh"
if [[ "$(readlink -f "$0")" != "$(readlink -f "$INSTALLED")" ]]; then install -m 700 "$0" "$INSTALLED"; fi
write_unit() { # <naam> <inhoud>
  if [[ "$(cat "$SYSTEMD_DIR/$1" 2>/dev/null || true)" != "$2" ]]; then printf '%s\n' "$2" > "$SYSTEMD_DIR/$1"; chmod 644 "$SYSTEMD_DIR/$1"; UNITS_CHANGED=1; fi
}
UNITS_CHANGED=0
if command -v systemctl >/dev/null 2>&1 && [[ -d "$SYSTEMD_DIR" ]]; then
  write_unit aquatech-staging-update.service "[Unit]
Description=Aquatech staging bijwerken (volgt develop)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=STAGING_DIR=$STAGING_DIR
ExecStart=$INSTALLED --timer
TimeoutStartSec=45min"
  write_unit aquatech-staging-update.timer "[Unit]
Description=Aquatech staging elke 15 minuten bijwerken

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
RandomizedDelaySec=60

[Install]
WantedBy=timers.target"
  [[ "$UNITS_CHANGED" == "1" ]] && systemctl daemon-reload
  systemctl enable --now aquatech-staging-update.timer >/dev/null 2>&1 || log "Waarschuwing: de timer kon niet worden ingeschakeld."
fi

# ---------- 12. Wat nog met de hand moet ----------
if [[ "$TIMER" != "1" ]]; then
  cat <<TEXT

Staging staat klaar. Nog met de hand te doen (eenmalig):
  1. EERST toegang dichtzetten: Cloudflare Zero Trust > Toegang > Toepassingen > Toevoegen (zelf gehost): domein
     $HOSTNAME_PUBLIC, beleid "Toestaan" alleen voor jouw e-mailadres.
  2. Dan pas publiceren: Cloudflare Zero Trust > Netwerken > Tunnels > de bestaande tunnel > Gepubliceerde toepassingen >
     Toevoegen: hostnaam $HOSTNAME_PUBLIC, service http://$ALIAS:3300
     (zonder stap 1 zou de installatie en het inloggen tijdelijk openbaar bereikbaar zijn).
Inloggen in de app: gebruiker beheer, wachtwoord in $STAGING_DIR/secrets/admin-password (root: cat). Het gedeelde wachtwoord
van de testaccounts staat in $STAGING_DIR/secrets/testdata-password. Er zijn geen koppelingen en geen mail.
TEXT
fi
