# AquaTech Hub: projectcontext

Productspecifieke kennis. De algemene werkwijze staat in `docs/WERKWIJZE.md`; het volledige technische werkgeheugen in `CLAUDE.md`.

## Doel en product
- Gehoste multitenant SaaS voor beregeningsexperts, ERP-achtig: dashboard met modules (de Beregeningsplanner is een module). Elke tenant gebruikt een eigen AI-API-sleutel.
- Niet bouwen: eigen boekhouding, CRM of HR. Bedrijfslogica zit in AquaTech Hub; n8n hooguit als optionele lijm.
- AI-functies in de app nooit via een Claude-abonnement (ToS). Op termijn moeten plannen ook zonder AI te genereren zijn.
- Webshop nog niet live: noindex tot go-live, geen verborgen tekst voor bots. Afhalen in Nunspeet niet promoten; bezorgen is leidend.
- Go-live later op een VPS; daarna repo en image privé (geparkeerd tot de VPS er is).
- Alleen PostgreSQL; SQLite wordt niet meer gebruikt, ook niet in tests.

## Bedrijfsregels
- Prijsvolgorde: prijsfactor artikel > voorkeursleverancier > diepste categorie > standaard, daarna afronding. Zakelijke categoriekorting komt erbovenop; groothandel = hoogste van staffel, klant en categorie (niet opgeteld); particulieren nooit categoriekorting.
- Een nieuwe inkoopprijs geeft een prijsvoorstel dat met één klik in het artikelscherm wordt goedgekeurd.
- Back-ups zijn instelbaar en zichtbaar in de app, met optioneel een kopie op Google Drive.

## Omgeving
- Repo `danieldh00/Aquatech`, applicatie in `hub/`; shop op `/`, app op `/app/`.
- Docker en Cloudflare-tunnel op apps01 (Proxmox-VM, 2 vCPU en 6 GB; host 16 GB RAM). `release.yml` bouwt naar GHCR, update-timer elk kwartier (`/opt/apps/aquatech`). PostgreSQL 17 met dagelijkse back-ups.
- Servertaken: zie AGENTS.md; het vaste commando draait op de PVE-host met `APPS01_SSH=daniel@apps01` + sudo.
- Beheerder werkt op Windows.
- Huisstijl AquaTech Service, Nunspeet: navy #1B3768, teal #37BAC8, groen #1A9F5B.

## Projectspecifieke werkafspraken
- Migraties: `MIGRATIONS` (db.js) én `PG_MIGRATIONS` (pgschema.js), positioneel.
- Elke PR met wijziging in `hub/` krijgt een fragment `changes/<naam>.md`; nooit `version`, `CHANGELOG.md` of `releases.js` aanraken.
- Reviews: de verplichte checks zijn *Claude code review* en *Claude security review*; CodeRabbit is uitgeschakeld.
