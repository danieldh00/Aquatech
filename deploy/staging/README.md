# AquaTech Hub staging (stg01)

Aparte omgeving om stapsgewijs in Vue te ontwikkelen zonder productie (apps01) te raken. Besluit Daniël 2026-11-24.

| Onderdeel | Staging | Productie |
|---|---|---|
| VM | `stg01` (2 vCPU, 3 GB, Proxmox) | `apps01` |
| Branch | `develop` | `master` |
| Image | `ghcr.io/danieldh00/aquatech-staging` (`staging.yml`) | `ghcr.io/danieldh00/aquatech` (`release.yml`) |
| Database | eigen PostgreSQL-container, alleen testdata | eigen PostgreSQL op apps01 |
| Uitrol | `update-staging.sh`, timer elke 10 min | `update.sh` (met back-up, cosign) |
| Mail | Mailpit (alles wordt opgevangen) | echte mailserver |
| Koppelingen | geen: het containernetwerk heeft geen uitgang | Mollie, Visma, Graph, Drive... |
| Bereikbaar | `staging.<domein>` achter Cloudflare Access | publiek |

## Inrichten
Alles loopt via servertaken (nooit losse commando's): één taak maakt de VM met `pve/stg01-create.sh`, een tweede
richt staging in met `setup-stg01.sh`. Handmatig blijft alleen Cloudflare: tunnel `stg01` aanmaken, het token in
`/opt/apps/aquatech-staging/.env` (`STAGING_TUNNEL_TOKEN`) zetten, de hostnames (`staging.<domein>` naar
`http://aquatech:3300` en een tweede voor Mailpit naar `http://mailpit:8025`) toevoegen en op beide een Access-regel
zetten.

## Gebruik
- Eerste start: beheerder aanmaken in de setup-pagina (installatiecode staat in `docker logs aquatech-staging`).
- Testdata: Hoofdbeheer > testomgeving > testdata vullen (`platform/test-data.js`); een geanonimiseerde kopie van productie komt later, bij Facturen.
- Mail: Beheer > Instellingen > E-mail, SMTP `mailpit` poort `1025`, zonder TLS en zonder login.
- Staging heeft nooit echte betalingen, mail of koppelingen. Zet daar nooit productiegeheimen in.
- Terugzetten of leegmaken: `docker compose down`, `data/` en `pgdata/` verwijderen, `setup-stg01.sh` opnieuw (testdata gaat verloren, dat is bedoeld).

## Egress-beleid
`compose.yml` zet app, database en Mailpit op een `internal: true`-netwerk. Alleen `cloudflared` hangt ook aan `edge`.
Een nieuw staging-onderdeel dat internet nodig heeft, komt expliciet op `edge` en wordt hier vermeld.
