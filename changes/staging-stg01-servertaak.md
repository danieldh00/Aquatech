---
titel: Servertaak voor de stagingomgeving
---

## Nieuws

## Changelog
Servertaak `012-staging-stg01-inrichten`: richt vanaf de Proxmox-host de aparte VM stg01 in (Docker, eigen PostgreSQL, Mailpit, Cloudflare-tunnel, update-timer) via `deploy/staging/`. Taken die op de Proxmox-host zelf draaien kennen nu een eigen lijst (`HOST_SIDE_TASK_IDS` in `servertaken.sh`, `openstaand-lijst` en `taak-vastleggen` op apps01). Het stagingscript rolt alleen `ghcr.io/danieldh00/aquatech-staging` uit, nooit het productie-image. Zie `docs/STAGING.md`.
