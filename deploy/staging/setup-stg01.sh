#!/usr/bin/env bash
# Eenmalig op de VM stg01 (als root): staging inrichten in /opt/apps/aquatech-staging. Veilig herhaalbaar; bestaande
# .env, secrets en data blijven staan. Vereist docker + docker compose (stg01-create.sh zet die via cloud-init klaar).
#
# SETUP_REF = een vaste commit van 40 tekens (de servertaak geeft die mee). Doet:
#   1. haalt compose.yml, update-staging.sh en de systemd-units op die commit;
#   2. maakt .env (database-wachtwoord willekeurig, tunnel-token leeg), secrets/master-key en de mappen;
#   3. start database, app en Mailpit; tunnel alleen als STAGING_TUNNEL_TOKEN in .env staat;
#   4. zet de timer aan.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech-staging}"
SETUP_REF="${SETUP_REF:-}"
[[ "$SETUP_REF" =~ ^[0-9a-f]{40}$ ]] || { echo "FOUT: SETUP_REF moet een volledige commit van 40 tekens zijn." >&2; exit 1; }
RAW="https://raw.githubusercontent.com/danieldh00/Aquatech/$SETUP_REF/deploy/staging"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
command -v docker >/dev/null || { echo "FOUT: docker ontbreekt op deze VM." >&2; exit 1; }

mkdir -p "$APP_DIR"/{data,pgdata,mailpit,secrets}
cd "$APP_DIR"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
for file in compose.yml update-staging.sh systemd/aquatech-staging-update.service systemd/aquatech-staging-update.timer; do
  mkdir -p "$tmp/$(dirname "$file")"
  curl -fsSL -m 60 "$RAW/$file" -o "$tmp/$file" || { echo "FOUT: ophalen van $file mislukt." >&2; exit 1; }
done
bash -n "$tmp/update-staging.sh"
install -m 644 "$tmp/compose.yml" compose.yml
install -m 755 "$tmp/update-staging.sh" update-staging.sh
install -m 644 "$tmp"/systemd/aquatech-staging-update.* "$SYSTEMD_DIR/"

if [[ ! -f .env ]]; then
  umask 077
  printf 'STAGING_DB_PASSWORD=%s\nSTAGING_TUNNEL_TOKEN=\nTZ=Europe/Amsterdam\n' "$(openssl rand -hex 24)" > .env
fi
if [[ ! -f secrets/master-key ]]; then
  (umask 077; openssl rand -base64 32 > secrets/master-key)
fi
# De app draait als uid 1000: data en mailpit moeten schrijfbaar zijn; de database beheert postgres zelf.
chown 1000:1000 data mailpit

profiles=()
grep -qE '^STAGING_TUNNEL_TOKEN=.+' .env && profiles=(--profile tunnel)
docker compose "${profiles[@]}" up -d
systemctl daemon-reload
systemctl enable --now aquatech-staging-update.timer >/dev/null
echo "Staging ingericht in $APP_DIR (tunnel: $([[ ${#profiles[@]} -gt 0 ]] && echo aan || echo 'nog niet, zet STAGING_TUNNEL_TOKEN in .env'))."
