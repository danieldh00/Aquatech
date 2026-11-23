---
titel: Veiligere standaarden in de voorbeeld-installatie
---

## Changelog
Audit B-37, geen migratie:
- `docker-compose.yml`: `POSTGRES_PASSWORD` is verplicht (geen publiek bekend standaardwachtwoord meer); `.env.example` en README aangepast.
- `hub/Dockerfile`: `HEALTHCHECK` op `/api/health` in het image zelf. Bewust niet gedaan: `USER node` in het image; de app start als root om `/data` aan uid 1000 te geven (`dropPrivileges`) en dat ligt in de productie-compose vast met `cap_add`.
- Let op voor bestaande installaties met deze voorbeeld-compose: zij gebruikten het oude standaardwachtwoord. Zet `POSTGRES_PASSWORD=aquatech-lokaal` in `.env` om verder te gaan met het bestaande databasevolume; een nieuw wachtwoord past het volume niet aan. (De productie-installatie op apps01 gebruikt `compose.localdb.yml` en is niet geraakt.)
