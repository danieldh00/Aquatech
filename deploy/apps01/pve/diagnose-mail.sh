#!/usr/bin/env bash
# Alleen-lezen diagnose van uitgaande mail: draai dit VANAF DE PROXMOX-HOST, als root.
# Test of de ingestelde mailserver bereikbaar is op poort 25, 465 en 587, vanaf de Proxmox-host (en Gmail ter vergelijking), vanaf apps01 en vanuit
# de app-container, met een controle op DNS, IPv6 en een firewall. Zo zie je of de internetprovider (bijv. KPN, die uitgaand
# poort 25 op consumentenlijnen blokkeert) of de eigen firewall de oorzaak is.
#
# In één commando (REF = een vaste commit, want GitHub cachet een branch een paar minuten):
#   curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/<REF>/deploy/apps01/pve/diagnose-mail.sh | bash
#
# Optioneel: MAIL_HOST=smtp.voorbeeld.nl (anders de host uit Beheer > Integraties > E-mail, gelezen uit de database),
# APPS01_SSH (standaard daniel@apps01), APP_DIR (standaard /opt/apps/aquatech), OUT.
# Uitvoer: /root/aquatech-mail-diagnose-<tijd>.txt. Het script wijzigt niets en leest nooit het wachtwoord.
set -uo pipefail
OUT="${OUT:-/root/aquatech-mail-diagnose-$(date +%Y%m%d-%H%M%S).txt}"
[[ $(id -u) -eq 0 ]] || { echo "FOUT: draai dit als root op de Proxmox-host." >&2; exit 1; }
SSH_TARGET="${APPS01_SSH:-daniel@apps01}"
SUDO=""; [[ "${SSH_TARGET%%@*}" != "root" ]] && SUDO="sudo -n"

# Poorttest met time-out; bash /dev/tcp, dus geen extra programma nodig.
probe() { # host poort
  local start=$SECONDS
  if timeout 6 bash -c 'exec 3<>/dev/tcp/"$1"/"$2"' _ "$1" "$2" 2>/dev/null; then echo "  $1:$2  OPEN ($((SECONDS - start)) s)"
  else echo "  $1:$2  GEEN VERBINDING (na $((SECONDS - start)) s: time-out = geblokkeerd/gefilterd, snel = geweigerd)"; fi
}

REMOTE_SCRIPT='
APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
sect() { printf "\n\n===== %s =====\n" "$*"; }
probe() { local start=$SECONDS; if timeout 6 bash -c '"'"'exec 3<>/dev/tcp/"$1"/"$2"'"'"' _ "$1" "$2" 2>/dev/null; then echo "  $1:$2  OPEN ($((SECONDS - start)) s)"; else echo "  $1:$2  GEEN VERBINDING (na $((SECONDS - start)) s: time-out = geblokkeerd/gefilterd, snel = geweigerd)"; fi; }
sect "Ingestelde mailserver (alleen host, poort, beveiliging en inlogsoort; nooit het wachtwoord)"
CFG=$(docker exec -u postgres aquatech-postgres psql -X -A -t -d aquatech -c "SELECT t.slug || chr(9) || s.value FROM aquatech.settings s JOIN aquatech.tenants t ON t.id = s.tenant_id WHERE s.key = '"'"'mailServer'"'"' AND t.environment = '"'"'live'"'"' ORDER BY t.slug" 2>&1)
echo "$CFG" | sed -E "s/\"(user|from|replyTo)\":\"[^\"]*\"/\"\\1\":\"…\"/g"
HOST="${MAIL_HOST:-}"
[ -z "$HOST" ] && HOST=$(echo "$CFG" | grep -oE "\"host\":\"[^\"]+\"" | head -1 | cut -d\" -f4)
case "$HOST" in *[!A-Za-z0-9.-]*) echo "WAARSCHUWING: de ingestelde host ziet er niet uit als een hostnaam en wordt niet getest."; HOST="";; esac
echo "Te testen host: ${HOST:-(geen gevonden; geef MAIL_HOST mee)}"
sect "Algemeen uitgaand verkeer (controle: 443 moet openen)"
probe 1.1.1.1 443; probe www.google.com 443
sect "Controlehosts: lukt het bij andere providers? (smtp.gmail.com, smtp.office365.com)"
for h in smtp.gmail.com smtp.office365.com; do for p in 25 465 587; do probe "$h" "$p"; done; done
if [ -n "$HOST" ]; then
  sect "DNS van $HOST (IPv4 en IPv6)"
  getent ahosts "$HOST" | awk "{print \"  \" \$1}" | sort -u
  sect "Poorten op $HOST vanaf apps01"
  for p in 25 465 587; do probe "$HOST" "$p"; done
  sect "Poorten op $HOST vanuit de app-container (verbinding per IPv4/IPv6-adres, zoals de app dat doet)"
  docker exec aquatech node -e "
const net=require(\"net\"),dns=require(\"dns\").promises;const host=process.argv[1];
(async()=>{const list=await dns.lookup(host,{all:true,verbatim:true}).catch(e=>{console.log(\"  DNS-fout:\",e.code);return[]});
console.log(\"  adressen:\",list.map(a=>a.address).join(\", \")||\"(geen)\");
for(const a of list)for(const port of [25,465,587]){await new Promise(done=>{const t=Date.now();const s=net.connect({host:a.address,port,timeout:6000});
const end=(r)=>{console.log(\"  \"+a.address+\":\"+port+\"  \"+r+\" (\"+(Date.now()-t)+\" ms)\");s.destroy();done()};
s.on(\"connect\",()=>end(\"OPEN\"));s.on(\"timeout\",()=>end(\"TIME-OUT (geblokkeerd/gefilterd)\"));s.on(\"error\",e=>end(e.code))})}})()" "$HOST" 2>&1
fi
sect "IPv6 vanaf apps01 en uit de container (zonder IPv6 hoort een IPv6-adres snel mislukken, niet hangen)"
ip -6 route show default 2>&1 | head -3; docker exec aquatech sh -c "ip -6 route 2>/dev/null | head -3 || echo geen-ip-commando"
sect "Firewall op apps01: regels die uitgaand mail of poorten blokkeren"
iptables -S 2>/dev/null | grep -iE "DROP|REJECT" | grep -iE "dport (25|465|587)|OUTPUT" | head -20
nft list ruleset 2>/dev/null | grep -iE "dport (25|465|587)" | head -10
ufw status 2>/dev/null | head -10
sect "Mailfouten in het app-log (laatste 24 u)"
docker logs --since 24h aquatech 2>&1 | grep -E "\[mail\]" | tail -n 15
sect "Publiek IP van apps01"
curl -s -m 8 https://api.ipify.org; echo
'

{
echo "Mail-diagnose $(date '+%F %T'); apps01 via $SSH_TARGET"
echo; echo "##### Proxmox-host zelf (zelfde internetlijn; als hier 25 dicht is ligt het aan de provider of de router)"
# De ingestelde host: MAIL_HOST, anders uit de database van apps01.
HOST="${MAIL_HOST:-}"
if [[ -z "$HOST" ]]; then
  HOST=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" "$SUDO docker exec -u postgres aquatech-postgres psql -X -A -t -d aquatech -c \"SELECT s.value FROM aquatech.settings s JOIN aquatech.tenants t ON t.id = s.tenant_id WHERE s.key = 'mailServer' AND t.environment = 'live' ORDER BY t.slug LIMIT 1\"" </dev/null 2>/dev/null | grep -oE '"host":"[^"]+"' | head -1 | cut -d'"' -f4)
fi
# De host komt uit een instelling die een beheerder kan wijzigen: alleen een gewone hostnaam of IP toestaan.
if [[ -n "$HOST" && ! "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,198}[A-Za-z0-9])?$ ]]; then echo "WAARSCHUWING: de ingestelde host ziet er niet uit als een hostnaam en wordt niet getest." >&2; HOST=""; fi
echo "Ingestelde host: ${HOST:-(niet gevonden)}"
for h in ${HOST:+"$HOST"} smtp.gmail.com; do for p in 25 465 587; do probe "$h" "$p"; done; done
echo; echo "##### Proxmox-firewall"; pve-firewall status 2>&1 | head -3; grep -hE "^(enable|policy_out)" /etc/pve/firewall/cluster.fw 2>/dev/null
echo; echo "##### apps01 en de app-container"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" "$SUDO env APP_DIR='${APP_DIR:-/opt/apps/aquatech}' MAIL_HOST='${MAIL_HOST:-}' bash -s" <<<"$REMOTE_SCRIPT" 2>&1
echo; echo "Klaar $(date '+%F %T')"
} >"$OUT" 2>&1
echo "Klaar: $OUT ($(wc -l <"$OUT") regels). Stuur dit bestand terug (er staat geen wachtwoord in)."
