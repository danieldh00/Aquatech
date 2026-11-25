#!/usr/bin/env bash
# Richt de stagingomgeving in op stg01 (Proxmox-VM, Debian/Ubuntu). Wordt door servertaak 012 vanaf de Proxmox-host
# via ssh uitgevoerd (zie deploy/apps01/pve/servertaken.sh); veilig om opnieuw te draaien.
#
# Doet:
#   1. installeert Docker met de compose-plugin uit de officiële Docker-apt-repository (sleutel op vingerafdruk gecontroleerd);
#   2. haalt compose.yml, update-staging.sh en de systemd-units op de vaste commit STAGING_REF op;
#   3. maakt (alleen als ze nog niet bestaan) willekeurige geheimen: hoofdsleutel, database-wachtwoord, database-url;
#      de tunnel-token (secrets/tunnel-token) plaatst de servertaak vooraf;
#   4. zet in .env het eerste image (:latest) en start de omgeving (met tunnel zodra er een token is);
#   5. installeert aquatech-stg-update.timer.
# Er wordt nooit iets uit productie gekopieerd: geen gegevens, geen hoofdsleutel, geen geheimen.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech-stg}"
STAGING_REF="${STAGING_REF:-}"
[[ "$STAGING_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "FOUT: STAGING_REF moet een volledige commit van 40 tekens zijn." >&2; exit 1; }
RAW="https://raw.githubusercontent.com/danieldh00/Aquatech/$STAGING_REF/deploy/staging"
IMAGE="ghcr.io/danieldh00/aquatech-staging"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DOCKER_KEY_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }

# ---------- 1. Docker ----------
if ! docker compose version >/dev/null 2>&1; then
  log "Docker met compose-plugin installeren."
  . /etc/os-release
  [[ "${ID:-}" == "debian" || "${ID:-}" == "ubuntu" ]] || die "Alleen Debian of Ubuntu wordt ondersteund (gevonden: ${ID:-onbekend})."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null
  install -m 0755 -d /etc/apt/keyrings
  gpg_tmp="$(mktemp -d)"
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$gpg_tmp/docker.gpg"
  actual="$(gpg --show-keys --with-colons "$gpg_tmp/docker.gpg" | awk -F: '/^fpr:/ {print $10; exit}')"
  [[ "$actual" == "$DOCKER_KEY_FINGERPRINT" ]] || { rm -rf "$gpg_tmp"; die "Vingerafdruk van de Docker-sleutel klopt niet ($actual)."; }
  gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg "$gpg_tmp/docker.gpg"
  rm -rf "$gpg_tmp"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi
command -v openssl >/dev/null || apt-get install -y -qq openssl >/dev/null

# ---------- 2. Bestanden ----------
install -d -m 755 "$APP_DIR" "$APP_DIR/data" "$APP_DIR/pgdata"
install -d -m 700 "$APP_DIR/secrets"
chown 1000:1000 "$APP_DIR/data"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for file in compose.yml update-staging.sh systemd/aquatech-stg-update.service systemd/aquatech-stg-update.timer; do
  curl -fsSL -m 60 "$RAW/$file" -o "$tmp/$(basename "$file")" || die "Kon $file niet ophalen."
done
bash -n "$tmp/update-staging.sh" || die "update-staging.sh is geen geldig script."
install -m 644 "$tmp/compose.yml" "$APP_DIR/compose.yml"
install -m 755 "$tmp/update-staging.sh" "$APP_DIR/update-staging.sh"
install -m 644 "$tmp/aquatech-stg-update.service" "$tmp/aquatech-stg-update.timer" "$SYSTEMD_DIR/"

# ---------- 3. Geheimen (alleen als ze er nog niet zijn) ----------
cd "$APP_DIR"
make_secret() { # <bestand> <aantal bytes>
  [[ -s "secrets/$1" ]] || { openssl rand -hex "$2" > "secrets/$1"; chmod 600 "secrets/$1"; }
}
make_secret master-key 32
make_secret postgres-password 24
if [[ ! -s secrets/database-url ]]; then
  printf 'postgres://postgres:%s@postgres:5432/aquatech?sslmode=disable' "$(cat secrets/postgres-password)" > secrets/database-url
  chmod 600 secrets/database-url
fi
# De compose-bestanden verwijzen naar elk geheim; zonder tunnel-token staat er een leeg bestand (de tunnel start dan niet).
[[ -e secrets/tunnel-token ]] || { : > secrets/tunnel-token; chmod 600 secrets/tunnel-token; }
# Docker mount geheimen met eigenaar en modus van het bestand: elk geheim hoort bij de gebruiker in de container die het leest
# (app 1000, postgres 999, cloudflared 65532) en is voor anderen onleesbaar.
chown 1000:1000 secrets/master-key secrets/database-url
chown 999:999 secrets/postgres-password
chown 65532:65532 secrets/tunnel-token
chmod 600 secrets/master-key secrets/database-url secrets/postgres-password secrets/tunnel-token
chmod 711 secrets

# ---------- 4. Eerste image en starten ----------
[[ -e .env ]] || { printf 'TZ=Europe/Amsterdam\n' > .env; chmod 600 .env; }
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
if [[ -z "$(env_get AQUATECH_TAG)" ]]; then
  docker pull -q "$IMAGE:latest" >/dev/null || die "Het image $IMAGE:latest bestaat nog niet: draai eerst de workflow Staging (push naar develop of afroep) en zet het pakket op openbaar of log in bij GHCR."
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:latest")"
  [[ "${revision:0:12}" =~ ^[0-9a-f]{12}$ ]] || die "Geen geldige revisie op het image."
  echo "AQUATECH_TAG=develop-${revision:0:12}" >> .env
fi
if [[ -s secrets/tunnel-token ]]; then
  grep -q '^COMPOSE_PROFILES=' .env || echo 'COMPOSE_PROFILES=tunnel' >> .env
  docker compose up -d
  log "Omgeving gestart, met Cloudflare-tunnel."
else
  docker compose up -d
  log "Omgeving gestart ZONDER tunnel (secrets/tunnel-token is leeg): alleen lokaal bereikbaar op de VM."
fi

# ---------- 5. Timer ----------
systemctl daemon-reload
systemctl enable --now aquatech-stg-update.timer
log "Klaar. Eerste start: de eerste beheerder maak je in de browser (installatiecode staat in 'docker logs aquatech-stg')."
