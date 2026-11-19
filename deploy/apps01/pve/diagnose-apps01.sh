#!/usr/bin/env bash
# Alleen-lezen diagnose van apps01 voor trage pagina's (soms 30 s wachten): draai dit VANAF DE PROXMOX-HOST, als root.
#
# In één commando, zonder bestand te bewaren (REF = een vaste commit, want GitHub cachet een branch een paar minuten):
#   curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/<REF>/deploy/apps01/pve/diagnose-apps01.sh | SAMPLE_SECONDS=600 bash
#
# Of als bestand:
#   SAMPLE_SECONDS=600 bash diagnose-apps01.sh    (standaard 150 s meten; langer vangt ook een uitschieter per kwartier)
#
# Uitvoer: /root/aquatech-diagnose-<tijd>.txt (op de Proxmox-host). Stuur dat bestand terug.
#
# Het script wijzigt niets: geen herstart, geen schrijfacties in de database, geen geheimen in de uitvoer
# (omgevingsvariabelen en secrets worden niet gelezen). apps01 laat root niet inloggen via SSH (bewust), dus het
# script verbindt als daniel@apps01 en voert het alleen-lezen deel uit met `sudo -n` (zoals servertaken.sh).
#
# Instellingen (optioneel): APPS01_SSH (standaard daniel@apps01), APPS01_CTID of APPS01_VMID (LXC via pct exec),
# APP_DIR (standaard /opt/apps/aquatech), SAMPLE_SECONDS (standaard 150), LOG_SINCE (standaard 48h), OUT.
set -uo pipefail

NAME="${APPS01_NAME:-apps01}"
OUT="${OUT:-/root/aquatech-diagnose-$(date +%Y%m%d-%H%M%S).txt}"
[[ $(id -u) -eq 0 ]] || { echo "FOUT: draai dit als root op de Proxmox-host." >&2; exit 1; }

# ---------- Verbinding: standaard ssh als daniel@apps01 + sudo -n; LXC alleen als APPS01_CTID is gezet ----------
if [[ -n "${APPS01_CTID:-}" ]]; then MODE=pct; GUEST_ID="$APPS01_CTID"; SSH_TARGET=""
else MODE=ssh; GUEST_ID=""; SSH_TARGET="${APPS01_SSH:-daniel@$NAME}"; fi
SUDO=""
if [[ "$MODE" == "ssh" && "${SSH_TARGET%%@*}" != "root" ]]; then SUDO="sudo -n"; fi

# ---------- Het script dat op apps01 draait (alleen lezen) ----------
REMOTE_SCRIPT='
APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-150}"
LOG_SINCE="${LOG_SINCE:-48h}"
sect() { printf "\n\n===== %s =====\n" "$*"; }
sql() { docker exec -u postgres aquatech-postgres psql -X -A -F" | " -d aquatech -c "$1" 2>&1 | head -${2:-60}; }

sect "Tijd, uptime, belasting"
date; uptime; nproc
sect "Geheugen en swap (swap die oploopt = trage pagina s)"
free -m; swapon --show 2>/dev/null; grep -E "^(pswpin|pswpout|pgmajfault|oom_kill)" /proc/vmstat
sect "Schijf (vol of trage schijf)"
df -h / "$APP_DIR" 2>/dev/null; command -v iostat >/dev/null && iostat -x 1 3 | tail -n 15
sect "CPU en wachten op schijf, 10 s (kolom wa = io-wait, st = steal van de host)"
vmstat 1 10
sect "OOM of kernelmeldingen"
dmesg -T 2>/dev/null | grep -iE "out of memory|oom-kill|blocked for more than|I/O error" | tail -n 20 || true
sect "Containers: status, herstarts, geheugen en CPU"
docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
for c in aquatech aquatech-postgres aquatech-cloudflared; do
  docker inspect -f "{{.Name}} gestart={{.State.StartedAt}} herstarts={{.RestartCount}} oom={{.State.OOMKilled}} geheugenlimiet={{.HostConfig.Memory}}" "$c" 2>/dev/null
done
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}"

sect "App: versie en health (tijd per aanroep)"
for i in 1 2 3; do curl -s -o /dev/null -m 60 -w "health %{http_code} %{time_total}s\n" http://localhost:3300/api/health; done
sect "App-log: stilvallers, databasetime-outs en fouten (laatste $LOG_SINCE)"
docker logs --since "$LOG_SINCE" aquatech 2>&1 | grep -iE "antwoordt niet|ETIMEDOUT|time-?out|statement timeout|canceling statement|ECONNRESET|ECONNREFUSED|Connection terminated|Back-up|Onderhoud|mislukt|\[fout |heap|ENOMEM|luistert op poort" | tail -n 120
sect "App-log: opstartmomenten (elke herstart = koude cache en onderhoud + back-up bij het starten)"
docker logs --since "$LOG_SINCE" aquatech 2>&1 | grep -E "luistert op poort" | tail -n 20
sect "Back-ups: tijdstip en grootte (een back-up draait in het app-proces en kan alles stilzetten)"
ls -l --time-style=long-iso "$APP_DIR"/data/backups 2>/dev/null | tail -n 10
sect "Updates: laatste uitrol en timer"
systemctl list-timers --no-pager 2>/dev/null | grep -i aquatech; journalctl -u aquatech-update.service --since "$LOG_SINCE" --no-pager 2>/dev/null | tail -n 40

sect "PostgreSQL: verbindingen en wat er nu draait"
sql "SELECT count(*) AS verbindingen, count(*) FILTER (WHERE state = '"'"'active'"'"') AS actief, count(*) FILTER (WHERE state LIKE '"'"'idle in transaction%'"'"') AS idle_in_transaction, count(*) FILTER (WHERE wait_event_type = '"'"'Lock'"'"') AS wacht_op_lock, current_setting('"'"'max_connections'"'"') AS max FROM pg_stat_activity WHERE datname = '"'"'aquatech'"'"'"
sql "SELECT pid, state, wait_event_type, wait_event, now() - query_start AS duur, now() - xact_start AS transactieduur, left(regexp_replace(query, '"'"'\s+'"'"', '"'"' '"'"', '"'"'g'"'"'), 140) AS query FROM pg_stat_activity WHERE datname = '"'"'aquatech'"'"' AND pid <> pg_backend_pid() AND state <> '"'"'idle'"'"' ORDER BY query_start LIMIT 20"
sect "PostgreSQL: locks die wachten"
sql "SELECT a.pid, a.wait_event, now() - a.query_start AS wacht, left(regexp_replace(a.query, '"'"'\s+'"'"', '"'"' '"'"', '"'"'g'"'"'), 120) AS query FROM pg_stat_activity a WHERE a.wait_event_type = '"'"'Lock'"'"'"
sect "PostgreSQL: trage queries uit het log (log_min_duration_statement = 1 s), laatste $LOG_SINCE"
docker logs --since "$LOG_SINCE" aquatech-postgres 2>&1 | grep -E "duration: [0-9]{4,}\.[0-9]+ ms|deadlock|could not|FATAL|too many connections|checkpoint (starting|complete).*(sync|write)=[0-9]{2,}" | tail -n 80
sect "PostgreSQL: grootste tabellen (afbeeldingen en foto s in de database maken een back-up zwaar)"
sql "SELECT relname AS tabel, pg_size_pretty(pg_total_relation_size(c.oid)) AS grootte, reltuples::bigint AS rijen FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '"'"'aquatech'"'"' AND c.relkind = '"'"'r'"'"' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 15"
sql "SELECT pg_size_pretty(pg_database_size('"'"'aquatech'"'"')) AS databasegrootte, round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2) AS cache_hit_pct FROM pg_stat_database WHERE datname = '"'"'aquatech'"'"'"
sect "PostgreSQL: tabellen met veel opeenvolgend lezen (ontbrekende index)"
sql "SELECT relname AS tabel, seq_scan, seq_tup_read, idx_scan, n_live_tup FROM pg_stat_user_tables WHERE schemaname = '"'"'aquatech'"'"' AND seq_scan > 100 ORDER BY seq_tup_read DESC LIMIT 12"
sect "PostgreSQL: pg_stat_statements (alleen als de extensie aan staat)"
sql "SELECT calls, round(mean_exec_time::numeric, 1) AS gem_ms, round(max_exec_time::numeric, 0) AS max_ms, left(regexp_replace(query, '"'"'\s+'"'"', '"'"' '"'"', '"'"'g'"'"'), 110) AS query FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 12"

sect "Cloudflare-tunnel: fouten (laatste $LOG_SINCE)"
docker logs --since "$LOG_SINCE" aquatech-cloudflared 2>&1 | grep -iE "error|ERR|retry|timeout|reconnect|unable|lost connection" | tail -n 30

sect "Meting: health van de app elke seconde, $SAMPLE_SECONDS s lang (een uitschieter = de app stond stil; health raakt de database niet)"
end=$((SECONDS + SAMPLE_SECONDS)); n=0; slow=0
while [ $SECONDS -lt $end ]; do
  t=$(curl -s -o /dev/null -m 60 -w "%{time_total}" http://localhost:3300/api/health); n=$((n+1))
  if awk "BEGIN{exit !($t > 1.0)}"; then slow=$((slow+1)); echo "$(date +%T) TRAAG health ${t}s | load $(cut -d" " -f1-3 /proc/loadavg) | vrij $(free -m | awk "/Mem:/{print \$7}") MB | wa $(vmstat 1 2 | tail -1 | awk "{print \$16}")"; fi
  sleep 1
done
echo "$n metingen, $slow langzamer dan 1 s"
sect "Klaar"; date
'

echo "Diagnose van $NAME ($MODE ${GUEST_ID:-$SSH_TARGET}); schrijft naar $OUT; duurt ca. $(( ${SAMPLE_SECONDS:-150} / 60 + 1 )) minuten ..."
ENVS="APP_DIR='${APP_DIR:-/opt/apps/aquatech}' SAMPLE_SECONDS='${SAMPLE_SECONDS:-150}' LOG_SINCE='${LOG_SINCE:-48h}'"
if [[ "$MODE" == "pct" ]]; then
  pct exec "$GUEST_ID" -- bash -c "$ENVS; $REMOTE_SCRIPT" >"$OUT" 2>&1
else
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" "$SUDO env $ENVS bash -s" <<<"$REMOTE_SCRIPT" >"$OUT" 2>&1
fi
if grep -qE "sudo: a password is required|Permission denied|Could not resolve|Connection refused|Connection timed out" "$OUT"; then
  echo "WAARSCHUWING: de verbinding of sudo lukte niet; kijk in $OUT en stuur de melding mee." >&2
fi
echo "Klaar: $OUT ($(wc -l <"$OUT") regels). Stuur dit bestand terug."
