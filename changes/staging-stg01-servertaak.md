---
titel: Servertaak voor de stagingomgeving
---

## Nieuws

## Changelog
Servertaak `012-staging-stg01-inrichten`: maakt vanaf de Proxmox-host de aparte VM stg01 aan, regelt via de Cloudflare-API de tunnel `aquatech-staging`, DNS en Access (alleen één e-mailadres) voor `aquatech-staging.den-hollander.com` en richt Docker, eigen PostgreSQL, Mailpit en de update-timer in via `deploy/staging/`. Taken die op de Proxmox-host zelf draaien kennen nu een eigen lijst (`HOST_SIDE_TASK_IDS` in `servertaken.sh`, opdrachten `openstaand-lijst` en `taak-vastleggen` op apps01); zonder Cloudflare API-token blijft de taak openstaan. Het stagingscript rolt alleen `ghcr.io/danieldh00/aquatech-staging` uit, nooit het productie-image. Zie `docs/STAGING.md`.
