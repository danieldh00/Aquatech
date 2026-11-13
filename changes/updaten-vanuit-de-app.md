---
titel: Updates installeren vanuit Beheer
---

## Nieuws
- [beheer] Nieuw in Beheer > Systeem > Updates: je ziet welke versie draait en welke klaarstaat, met wat er nieuw is. Met *Nu updaten* (en je wachtwoord ter bevestiging) installeert de server de nieuwe versie meteen. *Automatisch bijwerken* kun je daar ook uitzetten.
- Tijdens een update staat de site ongeveer een minuut in onderhoudsmodus: bovenin staat een melding, bekijken kan en opslaan even niet. Start de nieuwe versie niet goed, dan gaat de server vanzelf terug naar de vorige versie.

## Changelog
- **Updaten vanuit de app** (Beheer > Systeem > Updates, `beheer/updates.js`): `platform/system-update.js` en `system-update-routes.js` (`GET|POST /api/admin/system-update`, `DELETE .../request`, `PUT .../auto`). Alleen een eigen account in de live hoofdtenant met recht `beheer` (bij multitenancy alleen een hoofdbeheerder), wachtwoord opnieuw invullen, 5 pogingen per kwartier, auditlog `update_aangevraagd|ingetrokken|automatisch|wachtwoord_fout|geslaagd|mislukt|geweigerd`. `/api/me` geeft `systemUpdate`.
- Koppeling met de host via twee mappen: `UPDATE_STATUS_DIR` (alleen-lezen: `status.json`, `run.json`, `releases.json`, `maintenance.json`) en `UPDATE_REQUEST_DIR` (`request.json`, `policy.json`). Geen Docker-socket of root in de container. `tools/release-info.js` geeft de releasenotes van een image als JSON.
- **Onderhoudsmodus**: zolang `maintenance.json` bestaat (hoogstens 30 minuten) 503 `maintenance` met `Retry-After` op schrijfverzoeken (uitloggen en de Mollie-webhook blijven werken), kop `X-Aquatech-Maintenance` met een balk in elke pagina (`shared/common.js`, `.maintenance-bar`), achtergrondtaken slaan een ronde over, `/api/health` geeft `maintenance`.
- `deploy/apps01/update.sh`: pakt een aanvraag meteen op (`aquatech-update.path`), installeert alleen de versie van `:latest` (geen symlinks, max. 4 kB), onderhoudsmodus tijdens het wisselen, controle op healthy én de nieuwe versie op `/api/health`, rollback met status; automatisch bijwerken uit = alleen controleren. Nieuw: `setup-app-update.sh`, `systemd/aquatech-update.{path,service,timer}`, volumes in `compose.yml`.
