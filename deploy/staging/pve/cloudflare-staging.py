#!/usr/bin/env python3
"""Richt Cloudflare in voor staging: tunnel, DNS en Access (alleen het eigen e-mailadres).

Wordt door servertaak 012 (servertaken.sh) op de Proxmox-host gedraaid en is veilig opnieuw te draaien: wat er al is, wordt
hergebruikt of bijgewerkt. Het API-token komt uit de omgevingsvariabele CF_API_TOKEN (nooit uit een argument of log). Het
tunnel-token (het geheim waarmee cloudflared verbindt) gaat naar het bestand dat als eerste argument is opgegeven, mode 600.

Het API-token heeft alleen deze rechten nodig:
  Account > Cloudflare Tunnel > Edit, Account > Access: Apps and Policies > Edit, Account > Account Settings > Read,
  Zone > DNS > Edit, Zone > Zone > Read.

Omgevingsvariabelen: CF_API_TOKEN (verplicht), CF_ZONE (standaard den-hollander.com), CF_ACCESS_EMAIL (optioneel: e-mailadres
voor Access; leeg = het adres van de eerste accounteigenaar uit Cloudflare), CF_API_BASE (alleen voor tests).
Gebruik: cloudflare-staging.py <bestand voor het tunnel-token>
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = os.environ.get("CF_API_BASE", "https://api.cloudflare.com/client/v4").rstrip("/")
ZONE = os.environ.get("CF_ZONE", "den-hollander.com")
TUNNEL_NAME = "aquatech-staging"
APP_HOST = f"aquatech-staging.{ZONE}"
MAIL_HOST = f"aquatech-staging-mail.{ZONE}"
HOST_RE = re.compile(r"^[a-z0-9.-]+$")


def fail(message):
    """Meldt een fout (nooit een token) en stopt met een foutcode."""
    print(f"FOUT: {message}", file=sys.stderr)
    sys.exit(1)


def call(token, method, path, body=None):
    """Roept de Cloudflare-API aan en geeft het veld `result` terug; bij een fout stopt het met een leesbare melding."""
    request = urllib.request.Request(
        API + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            errors = json.load(error).get("errors", [])
            detail = "; ".join(str(item.get("message", "")) for item in errors)
        except Exception:
            detail = ""
        fail(f"Cloudflare weigert {method} {path.split('?')[0]} (HTTP {error.code}) {detail}".strip())
    except Exception as error:
        fail(f"Cloudflare is niet bereikbaar ({type(error).__name__}).")
    if not payload.get("success", False):
        fail(f"Cloudflare meldt een fout bij {method} {path.split('?')[0]}.")
    return payload.get("result")


def main():
    """Voert de stappen uit: zone, tunnel, ingress, DNS, Access voor de app en voor Mailpit."""
    token = os.environ.get("CF_API_TOKEN", "")
    if len(sys.argv) != 2 or not token:
        fail("Gebruik: CF_API_TOKEN=... cloudflare-staging.py <tunnel-tokenbestand>")
    if not HOST_RE.match(APP_HOST) or not HOST_RE.match(MAIL_HOST):
        fail("Ongeldige zonenaam.")
    target = sys.argv[1]

    zones = call(token, "GET", f"/zones?name={ZONE}")
    if not zones:
        fail(f"Zone {ZONE} niet gevonden voor dit token.")
    zone_id, account_id = zones[0]["id"], zones[0]["account"]["id"]

    tunnels = call(token, "GET", f"/accounts/{account_id}/cfd_tunnel?name={TUNNEL_NAME}&is_deleted=false")
    if tunnels:
        tunnel_id = tunnels[0]["id"]
        print(f"Tunnel {TUNNEL_NAME} bestaat al; hergebruikt.")
    else:
        tunnel_id = call(token, "POST", f"/accounts/{account_id}/cfd_tunnel", {"name": TUNNEL_NAME, "config_src": "cloudflare"})["id"]
        print(f"Tunnel {TUNNEL_NAME} aangemaakt.")
    call(token, "PUT", f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations", {"config": {"ingress": [
        {"hostname": APP_HOST, "service": "http://aquatech:3300"},
        {"hostname": MAIL_HOST, "service": "http://mailpit:8025"},
        {"service": "http_status:404"},
    ]}})

    for host in (APP_HOST, MAIL_HOST):
        record = {"type": "CNAME", "name": host, "content": f"{tunnel_id}.cfargotunnel.com", "proxied": True}
        existing = call(token, "GET", f"/zones/{zone_id}/dns_records?name={host}")
        if existing:
            call(token, "PUT", f"/zones/{zone_id}/dns_records/{existing[0]['id']}", record)
        else:
            call(token, "POST", f"/zones/{zone_id}/dns_records", record)
        print(f"DNS voor {host} staat goed.")

    email = os.environ.get("CF_ACCESS_EMAIL", "").strip()
    if not email:
        members = call(token, "GET", f"/accounts/{account_id}/members") or []
        owners = [m for m in members if any(r.get("name") in ("Super Administrator - All Privileges", "Administrator") for r in m.get("roles", []))]
        if len(owners) != 1:
            fail("Geen eenduidige accounteigenaar gevonden voor Access; zet CF_ACCESS_EMAIL op het toegestane adres.")
        email = owners[0].get("user", {}).get("email", "")
        print("Access-adres uit de accounteigenaar gekozen (zet CF_ACCESS_EMAIL om af te wijken).")
    if not email:
        fail("Geen e-mailadres voor Access gevonden; zet CF_ACCESS_EMAIL.")
    apps = call(token, "GET", f"/accounts/{account_id}/access/apps") or []
    for host, label in ((APP_HOST, "AquaTech staging"), (MAIL_HOST, "AquaTech staging Mailpit")):
        body = {
            "name": label, "domain": host, "type": "self_hosted", "session_duration": "24h",
            "policies": [{"name": "Eigenaar", "decision": "allow", "include": [{"email": {"email": email}}]}],
        }
        existing = [app for app in apps if app.get("domain") == host]
        if existing:
            call(token, "PUT", f"/accounts/{account_id}/access/apps/{existing[0]['id']}", body)
        else:
            call(token, "POST", f"/accounts/{account_id}/access/apps", body)
        print(f"Access voor {host}: alleen een vast e-mailadres mag erdoor.")

    tunnel_token = call(token, "GET", f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token")
    if not isinstance(tunnel_token, str) or len(tunnel_token) < 40:
        fail("Geen geldig tunnel-token ontvangen.")
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(tunnel_token)
    print(f"Klaar: https://{APP_HOST} (alleen via Cloudflare Access).")


main()
